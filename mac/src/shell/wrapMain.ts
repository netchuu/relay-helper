// A small program for `relay wrap` alone: starts faster than the whole `relay`, since it loads only the wrapper.
import { runWrap } from "./ptyWrap.ts";

process.exit(await runWrap(process.argv.slice(2)));
