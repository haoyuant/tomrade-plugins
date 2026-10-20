import type { parse as Parse } from "yaml";
// @ts-expect-error yaml's ESM build ships without its own types; they are the package's.
import { parse as esmParse } from "../node_modules/yaml/browser/index.js";

// Its Node build is CommonJS and requires `process`, which a plugin's ESM bundle cannot.
export const parse: typeof Parse = esmParse;
