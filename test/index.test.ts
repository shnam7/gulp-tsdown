import path from "node:path";
import { Readable } from "streamx";
import { build, type TsdownBundle } from "tsdown";
import { loadConfig } from "unconfig";
import Vinyl from "vinyl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import gulpTsdown from "../src/index.js";

// Mock external dependencies to isolate plugin behavior
vi.mock("tsdown", () => ({
  build: vi.fn(),
}));

vi.mock("unconfig", () => ({
  loadConfig: vi.fn(),
}));

// Extend Error interface to support Gulp ecosystem specific property
interface GulpPluginError extends Error {
  plugin?: string;
}

describe("gulpTsdown Plugin - 100% Coverage Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should collect file paths, trigger generateBundle hook, and stream virtual Vinyl objects with sourcemaps", async () => {
    // Setup mock values for successful memory compilation pipeline
    vi.mocked(loadConfig).mockResolvedValue({ config: {}, sources: [] });

    // Simulate tsdown build execution and grab the injected memory interceptor plugin
    vi.mocked(build).mockImplementation(async (config) => {
      const cfg = config as Record<string, unknown>;
      const plugins = cfg.plugins as Array<Record<string, unknown>>;
      const memoryPlugin = plugins.find((p) => p.name === "gulp-tsdown-memory-interceptor");

      if (memoryPlugin && typeof memoryPlugin.generateBundle === "function") {
        // Construct mock bundle assets to satisfy both object-typed maps and string-typed maps coverage
        const mockBundle: Record<string, unknown> = {
          "index.js": {
            type: "chunk",
            code: 'console.log("hello");',
            map: { version: 3, file: "index.js", sources: [], names: [], mappings: "" }, // Object map
          },
          "utils.js": {
            type: "chunk",
            code: 'console.log("utils");',
            map: '{"version":3,"mappings":""}', // String map
          },
          "ignored.txt": { type: "asset", source: "text" }, // Covers non-string asset branches
        };

        // Execute the generateBundle hook within tsdown mock
        memoryPlugin.generateBundle({}, mockBundle);
      }
      return [] as TsdownBundle[];
    });

    // Enable sourcemap via option to trigger map-processing logic block inside the plugin
    const stream = gulpTsdown({ outDir: "./dist", sourcemap: true });

    const file1 = new Vinyl({
      path: "/project/src/index.ts",
      contents: Buffer.from("console.log(1)"),
    });
    const file2 = new Vinyl({
      path: "/project/src/utils.ts",
      contents: Buffer.from("console.log(2)"),
    });

    const outputFiles: Vinyl[] = [];

    await new Promise<void>((resolve, reject) => {
      // Receive as 'unknown' to comply with streamx event signatures, then safe-cast inside
      stream.on("data", (chunk: unknown) => {
        outputFiles.push(chunk as Vinyl);
      });

      stream.on("finish", () => {
        try {
          expect(loadConfig).toHaveBeenCalled();
          expect(build).toHaveBeenCalledWith(
            expect.objectContaining({
              entry: ["/project/src/index.ts", "/project/src/utils.ts"],
              write: false,
              clean: false,
              sourcemap: true,
            }),
          );

          // Verify that 2 main JS files and 2 sourcemap files were successfully generated
          expect(outputFiles).toHaveLength(4);

          const paths = outputFiles.map((f) => f.path);
          const expectedJsPath = path.resolve(process.cwd(), "dist", "index.js");
          const expectedMapPath = path.resolve(process.cwd(), "dist", "index.js.map");
          const expectedUtilsJsPath = path.resolve(process.cwd(), "dist", "utils.js");
          const expectedUtilsMapPath = path.resolve(process.cwd(), "dist", "utils.js.map");

          expect(paths).toContain(expectedJsPath);
          expect(paths).toContain(expectedMapPath);
          expect(paths).toContain(expectedUtilsJsPath);
          expect(paths).toContain(expectedUtilsMapPath);
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("error", (err: Error) => reject(err));

      stream.write(file1);
      stream.write(file2);
      stream.end(() => {});
    });
  });

  it("should safely skip map generation when sourcemap option is set to false", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ config: { sourcemap: false }, sources: [] });

    vi.mocked(build).mockImplementation(async (config) => {
      const cfg = config as Record<string, unknown>;
      const plugins = cfg.plugins as Array<Record<string, unknown>>;
      const memoryPlugin = plugins.find((p) => p.name === "gulp-tsdown-memory-interceptor");

      if (memoryPlugin && typeof memoryPlugin.generateBundle === "function") {
        const mockBundle: Record<string, unknown> = {
          "index.js": {
            type: "chunk",
            code: 'console.log("no-map");',
            map: { version: 3, file: "index.js" }, // map metadata exists but should be ignored
          },
        };
        memoryPlugin.generateBundle({}, mockBundle);
      }
      return [] as TsdownBundle[];
    });

    const stream = gulpTsdown({ outDir: "./dist", sourcemap: false });
    const file = new Vinyl({
      path: "/project/src/index.ts",
      contents: Buffer.from("console.log(1)"),
    });
    const outputFiles: Vinyl[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: unknown) => {
        outputFiles.push(chunk as Vinyl);
      });

      stream.on("finish", () => {
        try {
          // JS chunk should be emitted, but map file must be skipped
          expect(outputFiles).toHaveLength(1);
          expect(outputFiles[0]?.path).toBe(path.resolve(process.cwd(), "dist", "index.js"));
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("error", (err: Error) => reject(err));

      stream.write(file);
      stream.end(() => {});
    });
  });

  it("should process asset types correctly if type parameter equals chunk or code is provided", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ config: {}, sources: [] });

    vi.mocked(build).mockImplementation(async (config) => {
      const cfg = config as Record<string, unknown>;
      const plugins = cfg.plugins as Array<Record<string, unknown>>;
      const memoryPlugin = plugins.find((p) => p.name === "gulp-tsdown-memory-interceptor");

      if (memoryPlugin && typeof memoryPlugin.generateBundle === "function") {
        const mockBundle: Record<string, unknown> = {
          // Case where type !== "chunk" but typeof code === "string" (covers the right side of the || operator)
          "legacy-asset.js": {
            type: "asset",
            code: 'console.log("legacy");',
          },
        };
        memoryPlugin.generateBundle({}, mockBundle);
      }
      return [] as TsdownBundle[];
    });

    const stream = gulpTsdown({ outDir: "./dist" });
    const file = new Vinyl({
      path: "/project/src/index.ts",
      contents: Buffer.from("console.log(1)"),
    });
    const outputFiles: Vinyl[] = [];

    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: unknown) => {
        outputFiles.push(chunk as Vinyl);
      });

      stream.on("finish", () => {
        try {
          expect(outputFiles).toHaveLength(1);
          expect(outputFiles[0]?.path).toBe(path.resolve(process.cwd(), "dist", "legacy-asset.js"));
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("error", (err: Error) => reject(err));

      stream.write(file);
      stream.end(() => {});
    });
  });

  it("should merge configuration from tsdown.config file with correct entry file resolution priority", async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      config: {
        entry: ["/project/src/config-entry.ts"],
        outDir: "./config-out",
        plugins: [{ name: "dummy" }],
      },
      sources: [],
    });
    vi.mocked(build).mockResolvedValue([] as TsdownBundle[]);

    const stream = gulpTsdown({ format: "cjs", plugins: [{ name: "option-dummy" }] });
    const file = new Vinyl({ path: "/project/src/ignored.ts", contents: Buffer.from("") });

    await new Promise<void>((resolve, reject) => {
      stream.on("finish", () => {
        try {
          expect(build).toHaveBeenCalledWith(
            expect.objectContaining({
              entry: ["/project/src/config-entry.ts"],
              format: "cjs",
            }),
          );
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("error", (err: Error) => reject(err));

      stream.write(file);
      stream.end(() => {});
    });
  });

  it("should emit a PluginError if no entry files are provided or resolved anywhere", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ config: {}, sources: [] });

    const stream = gulpTsdown();

    await new Promise<void>((resolve, reject) => {
      stream.on("error", (err: Error) => {
        try {
          const pluginError = err as GulpPluginError;
          expect(pluginError.plugin).toBe("gulp-tsdown");
          expect(pluginError.message).toContain("No entry files found");
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("finish", () => reject(new Error("Should have failed")));

      stream.end(() => {});
    });
  });

  it("should emit a PluginError if a streaming Vinyl file is passed", async () => {
    const stream = gulpTsdown();

    await new Promise<void>((resolve, reject) => {
      stream.on("error", (err: Error) => {
        try {
          const pluginError = err as GulpPluginError;
          expect(pluginError.plugin).toBe("gulp-tsdown");
          expect(pluginError.message).toBe("Streaming is not supported.");
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      const file = new Vinyl({
        path: "/project/src/stream.ts",
        contents: new Readable({ read() {} }) as unknown as NodeJS.ReadableStream,
      });
      stream.write(file);
      stream.end(() => {});
    });
  });
  it("should safely bypass null files and continue stream processing without adding them to entry metadata", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ config: {}, sources: [] });
    vi.mocked(build).mockResolvedValue([] as TsdownBundle[]);
    const stream = gulpTsdown({ outDir: "./out" });
    const nullFile = new Vinyl({ path: "/project/src/empty-folder", contents: null });
    const realFile = new Vinyl({
      path: "/project/src/main.ts",
      contents: Buffer.from("const a = 1;"),
    });
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (chunk: unknown) => {
        const file = chunk as Vinyl;
        expect(file.contents).toBeNull();
      });
      stream.on("finish", () => {
        try {
          expect(build).toHaveBeenCalledWith(
            expect.objectContaining({ entry: ["/project/src/main.ts"], outDir: "./out" }),
          );
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("error", (err: Error) => reject(err));
      stream.write(nullFile);
      stream.write(realFile);
      stream.end(() => {});
    });
  });
  it("should catch and propagate a standard Error object if tsdown build fails natively", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ config: {}, sources: [] });
    vi.mocked(build).mockRejectedValue(new Error("Tsdown internal compiler failure"));
    const stream = gulpTsdown();
    const file = new Vinyl({ path: "/project/src/main.ts", contents: Buffer.from("") });
    await new Promise<void>((resolve, reject) => {
      stream.on("error", (err: Error) => {
        try {
          const pluginError = err as GulpPluginError;
          expect(pluginError.plugin).toBe("gulp-tsdown");
          expect(pluginError.message).toBe("Tsdown internal compiler failure");
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("finish", () => reject(new Error("Should have failed")));
      stream.write(file);
      stream.end(() => {});
    });
  });
  it("should safely wrap non-error catches into a formal Error object structure", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ config: {}, sources: [] });
    vi.mocked(build).mockRejectedValue("Raw string runtime panic exception");
    const stream = gulpTsdown();
    const file = new Vinyl({ path: "/project/src/main.ts", contents: Buffer.from("") });
    await new Promise<void>((resolve, reject) => {
      stream.on("error", (err: Error) => {
        try {
          const pluginError = err as GulpPluginError;
          expect(pluginError.plugin).toBe("gulp-tsdown");
          expect(pluginError.message).toBe("Raw string runtime panic exception");
          resolve();
        } catch (e) {
          reject(e as Error);
        }
      });
      stream.on("finish", () => reject(new Error("Should have failed")));
      stream.write(file);
      stream.end(() => {});
    });
  });
});
