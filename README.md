# gulp-tsdown

Gulp plugin for compiling and bundling TypeScript using [tsdown](https://github.com).

It runs entirely **in-memory** (`write: false`), passing the compiled chunks and source maps directly into the Gulp stream without modifying or deleting your existing local files or `outDir` contents.

You can use inline configuration as option to the pkugin. tsdown configuration file(`tsdown.config.{ts,js,mjs,cjs}`) will be automatically deteceted and respected, but the inline config has higher priority.

Built on top of `streamx.Transform` for optimized stream handling and modern Gulp ecosystem compliance.

## Installation

```bash
npm install --save-dev gulp-tsdown tsdown streamx vinyl
```

## Usage

```javascript
import gulp from "gulp";
import tsdown from "gulp-tsdown";

export const foo = () => {
  const tsdownOptions = {
    format: ["esm", "cjs"],
    dts: true, // Generate declaration files (.d.ts)
    sourcemap: true,
    minify: true,
  };
  gulp
    .src("./src/scripts/app.ts") // Pass entry files through gulp.src
    .pipe(tsdown(tsdownOptions)) // Automatically picks up tsdown.config.ts
    .pipe(gulp.dest("./dist")); // Writes virtual bundles cleanly onto the disk
};
```

If you are using typescript, the type for options is available from _gulp-tsdown_.

```typescript
import gulpTsDown, { GulpTsdownOptions } from "gulp-tsdown";
```

### tsdown configuration

Create a `tsdown.config.ts` (or `.js`, `.mjs`) at the root of your project:

```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  format: ["esm", "cjs"],
  dts: true, // Generate declaration files (.d.ts)
  sourcemap: true,
  outDir: "dist", // Used to resolve the virtual Gulp stream base path
});
```

### Using with [`gulp-tron`](https://github.com/shnam7/gulp-tron)

Excerpt from [gulp-tron example #15](https://github.com/shnam7/gulp-tron/blob/main/examples/15-twig/gulpfile.js)

```js
import gulp from "gulp";
import tsdownG from "gulp-tsdown";

const scripts = {
  name: "scripts",

  build(bs) {
    bs.src()
      .debug("src:")
      //--- Using gulp-tsdown
      .pipe(
        tsdownG({
          format: ["cjs", "esm"],
          dts: true,
          sourcemap: true,
          fixedExtension: true,
        }),
      )
      .debug("tsdown");

    // create dts-file-only stream if necessary
    const dts = bs.clone().filter(["*.d.mts", "*.d.cts"]);
    dts.debug("dts:");

    // create map-file-only stream if necessary
    const map = bs.clone().filter("*.map");
    map.debug("map:");

    // create mts and cjs file only stream if necessary
    const js = bs.clone().filter(["!*.d.ts", "*.mts", "*.cjs"]);
    js.debug("ts:");

    // bs still has all the files.
    bs.dest();
  },

  src: path.join(srcRoot, "scripts/**/app.ts"),
  dest: path.join(destRoot, "js"),
};

tron.task(scripts);
```

## API

### gulpTsdown(options?)

#### options

- Type: `GulpTsdownOptions` (imported from `gulp-tsdown`)
- Default: `{}`

You can pass explicit `tsdown` configuration options directly into the plugin. Options passed via the plugin take priority over properties defined in `tsdown.config.ts`.

```javascript
gulp
  .src("./src/index.ts")
  .pipe(
    gulpTsdown({
      minify: true, // Override or append specific options programmatically
      outDir: "custom-build-folder",
    }),
  )
  .pipe(gulp.dest("./custom-build-folder"));
```

## Notes

- **Streaming Not Supported**: Gulp's streaming mode (`gulp.src('...', { buffer: false })`) is not supported. Ensure files are passed as buffers (default Gulp behavior).
- **Null Files Passed Safe**: Directory structures and empty null files flowing down the stream are safely passed through without interrupting the compilation pipeline.

## License

[MIT](./LICENSE)
