import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
const run = promisify(execFile);
function decode(value: string) {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
export function officeText(bytes: Buffer, extension: string): string {
  let total = 0, count = 0;
  const files = unzipSync(bytes, { filter: entry => {
    const selected = extension === "docx" ? entry.name === "word/document.xml"
      : extension === "pptx" ? /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)
      : /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(entry.name);
    if (!selected) return false;
    total += entry.originalSize; count++;
    if (entry.originalSize > 2_000_000 || total > 8_000_000 || count > 100) throw new Error("Office document exceeds the safe extraction limit.");
    return true;
  } });
  const names = Object.keys(files).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  if (names.length > 100) throw new Error("Office document exceeds 100 parts.");
  const shared = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)]
    .map(match => decode([...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(item => item[1]).join(""))) : [];
  return names.filter(name => name !== "xl/sharedStrings.xml").map(name => {
    const xml = strFromU8(files[name]);
    const content = extension === "xlsx"
      ? [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row => [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(cell => {
        const value = cell[2].match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? cell[2].match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? "";
        return decode(/\bt="s"/.test(cell[1]) ? shared[Number(value)] ?? "" : value);
      }).join("\t")).join("\n")
      : [...xml.matchAll(/<(?:w:|a:)?t\b[^>]*>([\s\S]*?)<\/(?:w:|a:)?t>/g)].map(match => decode(match[1])).join("\n");
    return content.trim() ? `${name}\n${content}` : "";
  }).filter(Boolean).join("\n\n");
}
export async function binaryText(bytes: Buffer, extension: string, signal: AbortSignal): Promise<{ text?: string; audio?: Buffer }> {
  const directory = await mkdtemp(path.join(tmpdir(), "zipy-media-"));
  try {
    const input = path.join(directory, `input.${extension}`);
    await writeFile(input, bytes);
    if (extension === "pdf") {
      if (bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("File is not a PDF.");
      const output = path.join(directory, "text.txt");
      await run("pdftotext", ["-layout", "-enc", "UTF-8", input, output], { signal, timeout: 30_000, maxBuffer: 1_000_000 });
      return { text: await readFile(output, "utf8") };
    }
    const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", input], { signal, timeout: 15_000, maxBuffer: 100_000 });
    const duration = Number(JSON.parse(probe.stdout).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 180) throw new Error("Audio/video must contain speech and be at most three minutes long.");
    const output = path.join(directory, "audio.wav");
    await run("ffmpeg", ["-nostdin", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", output], { signal, timeout: 45_000, maxBuffer: 100_000 });
    return { audio: await readFile(output) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
