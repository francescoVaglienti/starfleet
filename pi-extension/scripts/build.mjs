import { copyFile, mkdir } from "node:fs/promises";

await mkdir(new URL("../skills/fleet/", import.meta.url), { recursive: true });
await copyFile(new URL("../../skill/SKILL.md", import.meta.url), new URL("../skills/fleet/SKILL.md", import.meta.url));
await copyFile(new URL("../../LICENSE", import.meta.url), new URL("../LICENSE", import.meta.url));
