import { Readable } from "node:stream";
import Vinyl from "vinyl";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks -----------------------------------------------------------------
vi.mock("unconfig", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("tsdown", () => ({
  build: vi.fn(),
}));

import { build, type UserConfig } from "tsdown";
import { loadConfig } from "unconfig";
import gulpTsdown from "../src/index";

const mockedLoadConfig = vi.mocked(loadConfig);
const mockedBuild = vi.mocked(build);

type Bundle = Record<string, { code?: string; source?: string; map?: unknown } | undefined>;

// function getBuildConfig(index = 0): Partial<UserConfig> {
//   return (mockedBuild.mock.calls[index]?.[0] as Partial<UserConfig>) || {};
// }

/** Finds the in-memory interceptor plugin passed to `build()`. */
function findMemoryPlugin(config: Parameters<typeof build>[0]): {
  generateBundle: (o: unknown, b: Bundle) => void;
} {
  const plugins = Array.isArray(config?.plugins)
    ? config.plugins
    : config?.plugins
      ? [config.plugins]
      : [];

  const plugin = plugins.find((p) => {
    if (p && typeof p === "object" && "name" in p) {
      return p.name === "gulp-tsdown-memory-interceptor";
    }
    return false;
  });
  if (!plugin) throw new Error("memory interceptor plugin not found in config.plugins");
  return plugin as unknown as { generateBundle: (o: unknown, b: Bundle) => void };
}

// function findMemoryPlugin(config: any): { generateBundle: (o: unknown, b: Bundle) => void } {
//   const plugin = config.plugins.find((p: any) => p?.name === "gulp-tsdown-memory-interceptor");
//   if (!plugin) throw new Error("memory interceptor plugin not found in config.plugins");
//   return plugin;
// }

/** Runs the plugin end-to-end: writes input files, ends the stream, collects output Vinyl files. */
function run(
  pluginOptions: Parameters<typeof gulpTsdown>[0],
  inputFiles: Vinyl[] = [],
): Promise<{ files: Vinyl[]; buildConfig: Partial<UserConfig>; error: Error | null }> {
  return new Promise((resolve, reject) => {
    const stream = gulpTsdown(pluginOptions);
    const outFiles: Vinyl[] = [];
    let settled = false;

    stream.on("data", (chunk: unknown) => outFiles.push(chunk as Vinyl));
    stream.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      resolve({
        files: outFiles,
        buildConfig: mockedBuild.mock.calls.at(-1)?.[0] as Partial<UserConfig>,
        error: err,
      });
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      resolve({
        files: outFiles,
        buildConfig: mockedBuild.mock.calls.at(-1)?.[0] as Partial<UserConfig>,
        error: null,
      });
    });

    for (const file of inputFiles) stream.write(file);
    stream.end(null);

    setTimeout(() => {
      if (!settled) reject(new Error("stream did not settle in time"));
    }, 2000);
  });
}

function vinylFile(filePath: string, contents: string | null = ""): Vinyl {
  return new Vinyl({
    cwd: process.cwd(),
    path: filePath,
    contents: contents === null ? null : Buffer.from(contents),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedLoadConfig.mockResolvedValue({ config: {}, sources: [] });
  mockedBuild.mockResolvedValue([]);
});

describe("transform", () => {
  it("passes null files through untouched", async () => {
    const nullFile = vinylFile("a.ts", null);
    const { files, error } = await run({ entry: ["x.ts"] }, [nullFile]);
    expect(error).toBeNull();
    // the null file itself is forwarded (isNull short-circuit), no bundle output requested
    expect(files).toContain(nullFile);
  });

  it("errors on streaming files", async () => {
    const streamFile = new Vinyl({
      cwd: process.cwd(),
      path: "a.ts",
      contents: new Readable({ read() {} }),
    });
    const { error } = await run({ entry: ["x.ts"] }, [streamFile]);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/Streaming is not supported/);
  });

  it("collects buffer file paths to use as entry when no entry is configured", async () => {
    const file = vinylFile("/proj/src/one.ts", "export {}");
    await run({}, [file]);
    expect(mockedBuild).toHaveBeenCalledTimes(1);

    const configArg = mockedBuild.mock.calls[0]?.[0] as Partial<UserConfig> | undefined;
    expect(configArg?.entry).toEqual(["/proj/src/one.ts"]);
  });
});

describe("entry resolution", () => {
  it("errors when no entry can be resolved from options, config, or files", async () => {
    const { error } = await run({});
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/No entry files found/);
    expect(mockedBuild).not.toHaveBeenCalled();
  });

  it("errors when resolved entry is an empty array", async () => {
    const { error } = await run({ entry: [] });
    expect(error?.message).toMatch(/No entry files found/);
  });

  it("prefers pluginOptions.entry over config entry and collected files", async () => {
    mockedLoadConfig.mockResolvedValue({ config: { entry: ["config.ts"] }, sources: [] });
    const file = vinylFile("/proj/gulp-collected.ts", "");
    await run({ entry: ["option.ts"] }, [file]);

    const configArg = mockedBuild.mock.calls[0]?.[0] as Partial<UserConfig> | undefined;
    expect(configArg?.entry).toEqual(["option.ts"]);
  });

  it("falls back to tsdown.config entry when pluginOptions has none", async () => {
    mockedLoadConfig.mockResolvedValue({ config: { entry: ["config.ts"] }, sources: [] });
    await run({});
    const configArg = mockedBuild.mock.calls[0]?.[0] as Partial<UserConfig> | undefined;
    expect(configArg?.entry).toEqual(["config.ts"]);
  });
});

describe("outDir resolution", () => {
  it("defaults to dist", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"] },
      { "index.js": { code: "console.log(1)" } },
    );
    expect(files[0]?.path).toContain(`dist${require("node:path").sep}index.js`);
  });

  it("prefers pluginOptions.outDir over config outDir", async () => {
    mockedLoadConfig.mockResolvedValue({ config: { outDir: "config-out" }, sources: [] });
    const { files } = await withBundle(
      { entry: ["x.ts"], outDir: "option-out" },
      { "index.js": { code: "x" } },
    );
    expect(files[0]?.path).toContain(`option-out${require("node:path").sep}index.js`);
  });

  it("falls back to config outDir when option outDir is absent", async () => {
    mockedLoadConfig.mockResolvedValue({ config: { outDir: "config-out" }, sources: [] });
    const { files } = await withBundle({ entry: ["x.ts"] }, { "index.js": { code: "x" } });
    expect(files[0]?.path).toContain(`config-out${require("node:path").sep}index.js`);
  });
});

describe("plugins merging", () => {
  it("appends the memory interceptor after existing config and option plugins", async () => {
    const configPlugin = { name: "config-plugin" };
    const optionPlugin = { name: "option-plugin" };
    mockedLoadConfig.mockResolvedValue({ config: { plugins: [configPlugin] }, sources: [] });
    await run({ entry: ["x.ts"], plugins: [optionPlugin] });
    const configArg = mockedBuild.mock.calls[0]?.[0] as Partial<UserConfig> | undefined;
    const plugins = Array.isArray(configArg?.plugins)
      ? configArg.plugins
      : configArg?.plugins
        ? [configArg.plugins]
        : [];

    const pluginNames = plugins.map((p) => {
      return p && typeof p === "object" && "name" in p ? p.name : "";
    });

    // const pluginNames = mockedBuild.mock.calls[0][0].plugins;
    expect(pluginNames).toEqual([
      "config-plugin",
      "option-plugin",
      "gulp-tsdown-memory-interceptor",
    ]);
  });

  it("handles absence of config/option plugins gracefully", async () => {
    await run({ entry: ["x.ts"] });

    const configArg = mockedBuild.mock.calls[0]?.[0] as Partial<UserConfig> | undefined;
    const plugins = Array.isArray(configArg?.plugins)
      ? configArg.plugins
      : configArg?.plugins
        ? [configArg.plugins]
        : [];

    expect(plugins).toHaveLength(1);
    const firstPlugin = plugins[0];
    const pluginName =
      firstPlugin && typeof firstPlugin === "object" && "name" in firstPlugin
        ? firstPlugin.name
        : "";

    expect(pluginName).toBe("gulp-tsdown-memory-interceptor");
  });
});

describe("dts config merging", () => {
  it("leaves dts undefined when neither config nor options set it", async () => {
    await run({ entry: ["x.ts"] });
    const configArg = mockedBuild.mock.calls[0] as Partial<UserConfig> | undefined;
    expect(configArg?.dts).toBeUndefined();
  });

  it("injects the memory interceptor into an object-form dts config, preserving existing plugins", async () => {
    const existingDtsPlugin = { name: "existing-dts-plugin" };
    await run({ entry: ["x.ts"], dts: { plugins: [existingDtsPlugin] } } as Partial<UserConfig>);

    const configArg = mockedBuild.mock.calls?.[0]?.[0] as Partial<UserConfig> | undefined;
    const dts = configArg?.dts;
    const dtsPlugins =
      dts && typeof dts === "object" && "plugins" in dts && Array.isArray(dts.plugins)
        ? dts.plugins
        : [];

    const pluginNames = dtsPlugins.map((p) => {
      return p && typeof p === "object" && "name" in p ? p.name : "";
    });

    expect(pluginNames).toEqual(["existing-dts-plugin", "gulp-tsdown-memory-interceptor"]);
  });

  it("merges config-level dts object with option-level dts object", async () => {
    mockedLoadConfig.mockResolvedValue({
      config: { dts: { resolve: true } },
      sources: [],
    });
    await run({ entry: ["x.ts"], dts: { sourcemap: true } });

    const configArg = mockedBuild.mock.calls[0]?.[0];
    const rawDts =
      configArg && typeof configArg === "object" && "dts" in configArg ? configArg.dts : null;
    if (!rawDts || typeof rawDts !== "object") {
      throw new Error("dts option is missing or not an object");
    }

    const dts = rawDts as { resolve?: boolean; sourcemap?: boolean; plugins?: unknown[] };
    expect(dts.resolve).toBe(true);
    expect(dts.sourcemap).toBe(true);
    expect(dts.plugins).toEqual([
      expect.objectContaining({ name: "gulp-tsdown-memory-interceptor" }),
    ]);
  });

  it("still injects the interceptor when dts is simply `true`", async () => {
    await run({ entry: ["x.ts"], dts: true });
    const configArg = mockedBuild.mock.calls[0]?.[0] as Partial<UserConfig> | undefined;
    const dts = configArg?.dts;
    const dtsPlugins = dts && typeof dts === "object" && "plugins" in dts ? dts.plugins : undefined;

    expect(dtsPlugins).toEqual([
      expect.objectContaining({ name: "gulp-tsdown-memory-interceptor" }),
    ]);
  });
});

describe("generateBundle - standard output", () => {
  it("emits a file whose content is under `code`", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"] },
      {
        "index.js": { code: "console.log('hi')" },
      },
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.contents?.toString()).toBe("console.log('hi')");
    expect(files[0]?.path.endsWith("index.js")).toBe(true);
  });

  it("emits a file whose content is under `source` (declaration output)", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"] },
      {
        "index.d.ts": { source: "export declare const x: number;" },
      },
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.contents?.toString()).toBe("export declare const x: number;");
  });

  it("skips bundle entries with neither `code` nor `source`", async () => {
    const { files } = await withBundle({ entry: ["x.ts"] }, { "asset.bin": { map: undefined } });
    expect(files).toHaveLength(0);
  });

  it("skips falsy bundle entries", async () => {
    const { files } = await withBundleRaw({ entry: ["x.ts"] }, { "ghost.js": undefined });
    expect(files).toHaveLength(0);
  });

  it("does not emit the same file name twice", async () => {
    const { files } = await withGeneratedBundles({ entry: ["x.ts"] }, [
      { "index.js": { code: "a" } },
      { "index.js": { code: "a" } },
    ]);
    expect(files).toHaveLength(1);
  });
});

describe("generateBundle - .d.cts forking", () => {
  it("forks .d.cts from .d.ts when cjs format + fixedExtension are both on", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], format: ["esm", "cjs"], fixedExtension: true },
      { "index.d.ts": { source: "export type X = 1;" } },
    );
    const names = files.map((f) => f.path.split(require("node:path").sep).pop());
    expect(names).toContain("index.d.ts");
    expect(names).toContain("index.d.cts");
  });

  it("forks .d.cts from .d.mts (the fixedExtension esm naming) - regression for the reported bug", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], format: ["esm", "cjs"], fixedExtension: true },
      { "index.d.mts": { source: "export type X = 1;" } },
    );
    const names = files.map((f) => f.path.split(require("node:path").sep).pop());
    expect(names).toContain("index.d.mts");
    expect(names).toContain("index.d.cts");
  });

  it("rewrites relative .js/.mjs specifiers to .cjs inside the forked declaration", async () => {
    const source = [
      "import type { Foo } from './foo.mjs';",
      "export { Bar } from '../bar.js';",
    ].join("\n");
    const { files } = await withBundle(
      { entry: ["x.ts"], format: ["esm", "cjs"], fixedExtension: true },
      { "index.d.mts": { source } },
    );
    const forked = files.find((f) => f.path.endsWith("index.d.cts"));
    expect(forked?.contents?.toString()).toBe(
      ["import type { Foo } from './foo.cjs';", "export { Bar } from '../bar.cjs';"].join("\n"),
    );
  });

  it("does not fork when cjs is not one of the target formats", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], format: ["esm"], fixedExtension: true },
      { "index.d.mts": { source: "x" } },
    );
    expect(files.map((f) => f.path)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("d.cts")]),
    );
  });

  it("does not fork when fixedExtension is off", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], format: ["esm", "cjs"], fixedExtension: false },
      { "index.d.ts": { source: "x" } },
    );
    expect(files.map((f) => f.path)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("d.cts")]),
    );
  });

  it("reads format/fixedExtension from tsdown.config when options omit them", async () => {
    mockedLoadConfig.mockResolvedValue({
      config: { format: ["esm", "cjs"], fixedExtension: true },
      sources: [],
    });
    const { files } = await withBundle(
      { entry: ["x.ts"] },
      {
        "index.d.mts": { source: "x" },
      },
    );
    expect(files.map((f) => f.path.split(require("node:path").sep).pop())).toContain("index.d.cts");
  });

  it("does not double-fork an already-forked .d.cts file", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], format: ["esm", "cjs"], fixedExtension: true },
      { "index.d.cts": { source: "x" } },
    );
    expect(files).toHaveLength(1);
    expect(files[0]?.path.endsWith("index.d.cts")).toBe(true);
  });

  it("does not duplicate the forked file across repeated generateBundle calls (e.g. a second dts pass)", async () => {
    const bundle = { "index.d.mts": { source: "x" } };
    const { files } = await withGeneratedBundles(
      { entry: ["x.ts"], format: ["esm", "cjs"], fixedExtension: true },
      [bundle, bundle],
    );
    const ctsCount = files.filter((f) => f.path.endsWith("d.cts")).length;
    expect(ctsCount).toBe(1);
  });
});

describe("generateBundle - sourcemaps", () => {
  it("emits a .map file when sourcemap option is on and map is an object", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], sourcemap: true },
      { "index.js": { code: "x", map: { version: 3, mappings: "" } } },
    );
    const map = files.find((f) => f.path.endsWith(".js.map"));
    expect(map).toBeDefined();
    expect(JSON.parse((map?.contents ?? Buffer.alloc(0)).toString())).toEqual({
      version: 3,
      mappings: "",
    });
  });

  it("emits a .map file when map is already a string", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], sourcemap: true },
      { "index.js": { code: "x", map: '{"version":3}' } },
    );
    const map = files.find((f) => f.path.endsWith(".js.map"));
    expect(map?.contents?.toString()).toBe('{"version":3}');
  });

  it("reads sourcemap flag from config when option omits it", async () => {
    mockedLoadConfig.mockResolvedValue({ config: { sourcemap: true }, sources: [] });
    const { files } = await withBundle(
      { entry: ["x.ts"] },
      {
        "index.js": { code: "x", map: { version: 3 } },
      },
    );
    expect(files.some((f) => f.path.endsWith(".js.map"))).toBe(true);
  });

  it("does not emit a .map file when sourcemap option is off", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], sourcemap: false },
      { "index.js": { code: "x", map: { version: 3 } } },
    );
    expect(files.some((f) => f.path.endsWith(".map"))).toBe(false);
  });

  it("does not emit a .map file when there is no map data", async () => {
    const { files } = await withBundle(
      { entry: ["x.ts"], sourcemap: true },
      {
        "index.js": { code: "x" },
      },
    );
    expect(files.some((f) => f.path.endsWith(".map"))).toBe(false);
  });

  it("does not duplicate an already-emitted map file", async () => {
    const bundle = { "index.js": { code: "x", map: { version: 3 } } };
    const { files } = await withGeneratedBundles({ entry: ["x.ts"], sourcemap: true }, [
      bundle,
      bundle,
    ]);
    expect(files.filter((f) => f.path.endsWith(".map"))).toHaveLength(1);
  });
});

describe("build failures", () => {
  it("wraps a thrown Error from build() in a PluginError", async () => {
    mockedBuild.mockRejectedValue(new Error("boom"));
    const { error } = await run({ entry: ["x.ts"] });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/boom/);
  });

  it("wraps a non-Error throw from build() by stringifying it", async () => {
    mockedBuild.mockRejectedValue("just a string failure");
    const { error } = await run({ entry: ["x.ts"] });
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/just a string failure/);
  });

  it("wraps a loadConfig failure the same way", async () => {
    mockedLoadConfig.mockRejectedValue(new Error("config parse failed"));
    const { error } = await run({ entry: ["x.ts"] });
    expect(error?.message).toMatch(/config parse failed/);
  });
});

// --- helpers that run the flush lifecycle and then drive generateBundle ----

function withBundle(
  pluginOptions: Parameters<typeof gulpTsdown>[0],
  bundle: Bundle,
): Promise<{ files: Vinyl[]; buildConfig?: Partial<UserConfig> }> {
  return runWithGeneratedBundle(pluginOptions, bundle);
}

function withBundleRaw(
  pluginOptions: Parameters<typeof gulpTsdown>[0],
  bundle: Bundle,
): Promise<{ files: Vinyl[]; buildConfig?: Partial<UserConfig> }> {
  return runWithGeneratedBundle(pluginOptions, bundle);
}

function runWithGeneratedBundle(
  pluginOptions: Parameters<typeof gulpTsdown>[0],
  bundle: Bundle,
): Promise<{ files: Vinyl[]; buildConfig?: Partial<UserConfig> }> {
  return withGeneratedBundles(pluginOptions, [bundle]);
}

/**
 * Runs the plugin, invoking `generateBundle` once per entry in `bundles` from
 * inside the mocked `build()` - mirroring how tsdown may call it multiple
 * times across build/dts passes within a single flush() lifecycle.
 * `generateBundle` is an arrow function, so its `this` is always the real
 * Transform instance; output is read from the real stream via `run()`.
 */
function withGeneratedBundles(
  pluginOptions: Parameters<typeof gulpTsdown>[0],
  bundles: Bundle[],
): Promise<{ files: Vinyl[]; buildConfig?: Partial<UserConfig> }> {
  mockedBuild.mockImplementation(async (config: Parameters<typeof build>[0]) => {
    const plugin = findMemoryPlugin(config);

    // undefined 전달 시 발생할 수 있는 매개변수 타입 오류 방지
    for (const bundle of bundles) {
      plugin.generateBundle(undefined, bundle);
    }

    // any를 쓰지 않고 실제 build 함수의 비동기 반환 타입에 맞게 빈 배열로 반환
    return [] as Awaited<ReturnType<typeof build>>;
  });

  return run(pluginOptions).then(({ files, buildConfig, error }) => {
    if (error) throw error;
    return { files, buildConfig };
  });
}
