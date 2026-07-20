import path from "node:path";
import PluginError from "plugin-error";
import { Transform } from "streamx";
import { build, type InlineConfig, type UserConfig } from "tsdown";
import { loadConfig } from "unconfig";
import Vinyl from "vinyl";

const PLUGIN_NAME = "gulp-tsdown";

export type GulpTsdownOptions = InlineConfig;

export default function gulpTsdown(options: GulpTsdownOptions = {}): Transform {
  const files: string[] = [];

  return new Transform({
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

    async flush(cb: (err: Error | null) => void): Promise<void> {
      try {
        const { config: inlineConfig } = await loadConfig<InlineConfig>({
          cwd: process.cwd(),
          sources: [{ files: ["tsdown.config"], extensions: ["ts", "js", "mjs", "cjs"] }],
        });

        const baseConfig: UserConfig = inlineConfig ?? {};
        const pluginOptions: GulpTsdownOptions = options ?? {};

        const baseEntry = baseConfig.entry;
        const optionEntry = pluginOptions.entry;
        const resolvedEntry = optionEntry || baseEntry || (files.length > 0 ? files : undefined);

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

        const memoryOutputPlugin = {
          name: "gulp-tsdown-memory-interceptor",
          generateBundle: (_outputOptions: unknown, bundle: Record<string, unknown>) => {
            for (const fileName of Object.keys(bundle)) {
              const fileAsset = bundle[fileName] as Record<string, unknown> | undefined;

              if (fileAsset && (fileAsset.type === "chunk" || typeof fileAsset.code === "string")) {
                const codeContent = fileAsset.code;

                // Push compiled main JS codes into the Gulp stream
                if (typeof codeContent === "string") {
                  this.push(
                    new Vinyl({
                      cwd: process.cwd(),
                      base: resolvedOutDir,
                      path: path.resolve(resolvedOutDir, fileName),
                      contents: Buffer.from(codeContent, "utf-8"),
                    }),
                  );
                }

                // Intercept and parse the internal sourcemap data.
                // In 'write: false' mode, Rolldown keeps sourcemaps attached inside the asset metadata
                // instead of outputting separate keys. This ensures they are safely captured and streamed.
                const hasSourcemap = pluginOptions.sourcemap ?? baseConfig.sourcemap;
                if (hasSourcemap && fileAsset.map) {
                  const mapData =
                    typeof fileAsset.map === "object"
                      ? JSON.stringify(fileAsset.map)
                      : fileAsset.map;

                  if (typeof mapData === "string") {
                    this.push(
                      new Vinyl({
                        cwd: process.cwd(),
                        base: resolvedOutDir,
                        path: path.resolve(resolvedOutDir, `${fileName}.map`), // 기존 파일명 뒤에 .map 결합
                        contents: Buffer.from(mapData, "utf-8"),
                      }),
                    );
                  }
                }
              }
            }
          },
        };

        const finalConfig = {
          ...baseConfig,
          ...pluginOptions,
          entry: resolvedEntry,
          write: false,
          clean: false,
          plugins: [...existingPlugins, memoryOutputPlugin],
        };

        await build(finalConfig as InlineConfig);
        cb(null);
      } catch (err) {
        const errorObject = err instanceof Error ? err : new Error(String(err));
        cb(new PluginError(PLUGIN_NAME, errorObject, { showStack: true }));
      }
    },
  });
}
