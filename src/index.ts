import path from "node:path";
import PluginError from "plugin-error";
import { Transform } from "streamx";
// IMPORT ONLY TYPES AT THE TOP LEVEL
import type { InlineConfig, UserConfig } from "tsdown";
import { loadConfig } from "unconfig";
import Vinyl from "vinyl";

const PLUGIN_NAME = "gulp-tsdown";

export type GulpTsdownOptions = InlineConfig;

export default function gulpTsdown(options: GulpTsdownOptions = {}): Transform {
  const files: string[] = [];

  return new Transform({
    // Collect file paths flowing through the Gulp stream.
    transform(file: Vinyl, cb: (err: Error | null, data?: Vinyl) => void): void {
      if (file.isNull()) {
        cb(null, file);
        return;
      }
      if (file.isStream()) {
        cb(new PluginError(PLUGIN_NAME, "Streaming is not supported."));
        return;
      }

      files.push(file.path);
      cb(null);
    },

    // Execute tsdown and push generated bundles into the Gulp stream.
    async flush(cb: (err: Error | null) => void): Promise<void> {
      try {
        // Search for tsdown.config.* files from the project root directory.
        const { config: inlineConfig } = await loadConfig<InlineConfig>({
          cwd: process.cwd(),
          sources: [{ files: ["tsdown.config"], extensions: ["ts", "js", "mjs", "cjs"] }],
        });

        const baseConfig: UserConfig = inlineConfig ?? {};
        const pluginOptions: GulpTsdownOptions = options ?? {};

        const resolvedEntry =
          pluginOptions.entry || baseConfig.entry || (files.length > 0 ? files : undefined);

        if (!resolvedEntry || (Array.isArray(resolvedEntry) && resolvedEntry.length === 0)) {
          cb(
            new PluginError(
              PLUGIN_NAME,
              "No entry files found. Specify entry in tsdown.config or gulp.src()",
            ),
          );
          return;
        }

        const baseOutDir = typeof baseConfig.outDir === "string" ? baseConfig.outDir : undefined;
        const optionOutDir =
          typeof pluginOptions.outDir === "string" ? pluginOptions.outDir : undefined;
        const targetOutDir = optionOutDir || baseOutDir || "dist";
        const resolvedOutDir = path.resolve(process.cwd(), targetOutDir);

        const basePlugins = Array.isArray(baseConfig.plugins) ? baseConfig.plugins : [];
        const optionPlugins = Array.isArray(pluginOptions.plugins) ? pluginOptions.plugins : [];
        const existingPlugins = [...basePlugins, ...optionPlugins];

        // Dedup registry, scoped to this flush call, since multiple build/dts passes can emit the same file.
        const emittedFiles = new Set<string>();

        // Determine whether a cjs declaration needs to be forked from the esm one.
        const targetFormats = pluginOptions.format || baseConfig.format || ["esm"];
        const formatsArray = Array.isArray(targetFormats) ? targetFormats : [targetFormats];
        const isCjsTarget = formatsArray.includes("cjs");
        const isFixedExtension = pluginOptions.fixedExtension ?? baseConfig.fixedExtension ?? false;

        const memoryOutputPlugin = {
          name: "gulp-tsdown-memory-interceptor",
          generateBundle: (_outputOptions: unknown, bundle: Record<string, unknown>) => {
            for (const fileName of Object.keys(bundle)) {
              const fileAsset = bundle[fileName] as Record<string, unknown> | undefined;
              if (!fileAsset) continue;

              // tsdown wraps declaration output under 'source', and js/asset output under 'code'.
              const content =
                typeof fileAsset.code === "string"
                  ? fileAsset.code
                  : typeof fileAsset.source === "string"
                    ? fileAsset.source
                    : undefined;

              if (typeof content === "string") {
                // [A] Emit the file tsdown produced as-is (.js, .cjs, .mjs, .d.ts, .d.mts, ...).
                if (!emittedFiles.has(fileName)) {
                  this.push(
                    new Vinyl({
                      cwd: process.cwd(),
                      base: resolvedOutDir,
                      path: path.resolve(resolvedOutDir, fileName),
                      contents: Buffer.from(content, "utf-8"),
                    }),
                  );
                  emittedFiles.add(fileName);
                }

                // [B] Fork a .d.cts declaration from the esm declaration, in memory.
                // With fixedExtension enabled, tsdown emits the esm declaration as '.d.mts'
                // (not '.d.ts'), so both suffixes need to be matched here.
                const dtsMatch = fileName.match(/\.d\.m?ts$/);
                if (dtsMatch && isCjsTarget && isFixedExtension) {
                  const cjsDtsName = fileName.replace(/\.d\.m?ts$/, ".d.cts");

                  if (!emittedFiles.has(cjsDtsName)) {
                    // Rewrite relative import/export specifiers from .js/.mjs to .cjs
                    // so the forked declaration file resolves correctly under cjs.
                    const transformedContent = content
                      .replace(/(from\s+["']\.\.?\/[^"'\n]+)\.(js|mjs)(["'])/g, "$1.cjs$3")
                      .replace(/(import\s+["']\.\.?\/[^"'\n]+)\.(js|mjs)(["'])/g, "$1.cjs$3");

                    this.push(
                      new Vinyl({
                        cwd: process.cwd(),
                        base: resolvedOutDir,
                        path: path.resolve(resolvedOutDir, cjsDtsName),
                        contents: Buffer.from(transformedContent, "utf-8"),
                      }),
                    );
                    emittedFiles.add(cjsDtsName);
                  }
                }

                // [C] Emit the sourcemap alongside its file (e.g. .cjs -> .cjs.map), deduped.
                const hasSourcemap = pluginOptions.sourcemap ?? baseConfig.sourcemap;
                if (hasSourcemap && fileAsset.map) {
                  const mapData =
                    typeof fileAsset.map === "object"
                      ? JSON.stringify(fileAsset.map)
                      : fileAsset.map;

                  if (typeof mapData === "string") {
                    const mapFileName = `${fileName}.map`;

                    if (!emittedFiles.has(mapFileName)) {
                      this.push(
                        new Vinyl({
                          cwd: process.cwd(),
                          base: resolvedOutDir,
                          path: path.resolve(resolvedOutDir, mapFileName),
                          contents: Buffer.from(mapData, "utf-8"),
                        }),
                      );
                      emittedFiles.add(mapFileName);
                    }
                  }
                }
              }
            }
          },
        };

        // tsdown may run a separate build pass for dts output; inject the same
        // interceptor there so it also catches the declaration output (.d.ts/.d.mts).
        const dtsConfig =
          typeof baseConfig.dts === "object"
            ? baseConfig.dts
            : typeof pluginOptions.dts === "object"
              ? pluginOptions.dts
              : {};

        const existingDtsPlugins = Array.isArray((dtsConfig as Record<string, unknown>).plugins)
          ? ((dtsConfig as Record<string, unknown>).plugins as unknown[])
          : [];

        const finalConfig = {
          ...baseConfig,
          ...pluginOptions,
          entry: resolvedEntry,
          write: false, // Keep everything in memory; nothing is written to disk by tsdown itself.
          clean: false,
          plugins: [...existingPlugins, memoryOutputPlugin],
          dts:
            pluginOptions.dts || baseConfig.dts
              ? {
                  ...(typeof baseConfig.dts === "object" ? baseConfig.dts : {}),
                  ...(typeof pluginOptions.dts === "object" ? pluginOptions.dts : {}),
                  plugins: [...existingDtsPlugins, memoryOutputPlugin],
                }
              : undefined,
        };

        // DEFERRED RUNTIME IMPORT FOR THE BUILD FUNCTION
        const { build } = await import("tsdown");
        await build(finalConfig as InlineConfig);

        cb(null);
      } catch (err) {
        const errorObject = err instanceof Error ? err : new Error(String(err));
        cb(new PluginError(PLUGIN_NAME, errorObject, { showStack: true }));
      }
    },
  });
}
