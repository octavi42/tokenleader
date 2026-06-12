// Bun text imports (`with { type: "text" }`) resolve .svg files to their
// string contents — both under `bun run` and embedded in `bun build
// --compile` binaries. This declaration teaches tsc the same shape.
declare module "*.svg" {
  const text: string;
  export default text;
}
