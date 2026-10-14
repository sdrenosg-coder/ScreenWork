import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import sharp from "sharp";
import pg from "pg";
import { officeText, binaryText } from "@workspace/zipy/jobs/mediaExtraction";
import { runOcr } from "@workspace/zipy/ingest/ocr";
import { detectPii } from "@workspace/zipy/images/piiDetect";
import { redactPii } from "@workspace/zipy/images/redact";
import { getJob } from "@workspace/zipy/jobs/queue";
import { deleteMedia } from "@workspace/zipy/storage/mediaStore";
import { forWorkspace } from "@workspace/zipy/storage/routeStore";
import { registerObjectStoreDriver } from "@workspace/zipy/storage/objectStore";
import { LocalObjectStoreDriver } from "@workspace/zipy/storage/localDriver";
import { getConfig } from "@workspace/zipy/web/config";

const exec = promisify(execFile);
const signal = () => AbortSignal.timeout(30000);
const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)]))));
const offices = {
  docx: zip({ "word/document.xml": '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Open settings &amp; save your language. &#x2713;</w:t></w:r></w:p></w:body></w:document>' }),
  pptx: zip({
    "ppt/slides/slide10.xml": '<a:t>Slide ten: Save</a:t>',
    "ppt/slides/slide2.xml": '<a:t>Slide two: Choose language</a:t>',
    "ppt/slides/slide1.xml": '<a:t>Slide one: Open settings</a:t>',
  }),
  xlsx: zip({
    "xl/sharedStrings.xml": '<sst><si><r><t>Language</t></r><r><t> preference</t></r></si></sst>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><r><t>English</t></r><r><t> language</t></r></is></c><c><v>42</v></c></row></sheetData></worksheet>',
  }),
};
async function imageFixture() {
  return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="280"><rect width="1200" height="280" fill="white"/><g font-family="sans-serif" font-size="36" fill="black"><text x="40" y="65">Synthetic training fixture</text><text x="40" y="130">Open settings and save your language.</text><text x="40" y="210">privacy@example.test</text></g></svg>')).png().toBuffer();
}
async function mixedPdf(image: Buffer) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([700, 400]).drawText("Searchable page: open the settings menu and choose a language before saving.", { x: 30, y: 300, size: 14, font });
  const picture = await pdf.embedPng(image);
  pdf.addPage([700, 400]).drawImage(picture, { x: 20, y: 170, width: 660, height: 154 });
  return Buffer.from(await pdf.save());
}

test("Office extraction preserves entities, rich cells and numeric slide order; unsafe archives fail", async () => {
  expect(officeText(offices.docx, "docx")).toContain("settings & save your language. ✓");
  const slides = officeText(offices.pptx, "pptx");
  expect(slides.indexOf("Slide one")).toBeLessThan(slides.indexOf("Slide two"));
  expect(slides.indexOf("Slide two")).toBeLessThan(slides.indexOf("Slide ten"));
  expect(officeText(offices.xlsx, "xlsx")).toContain("Language preference\tEnglish language\t42");
  expect(() => officeText(Buffer.from("not a ZIP"), "docx")).toThrow();
  expect(() => officeText(zip({ "word/document.xml": "x".repeat(2_000_001) }), "docx")).toThrow("safe extraction limit");
});

test("mixed PDF extraction retains searchable text and renders the scanned page", async () => {
  const extracted = await binaryText(await mixedPdf(await imageFixture()), "pdf", signal());
  expect(extracted.text).toContain("Searchable page");
  expect(extracted.images?.map(image => image.at)).toEqual([2]);
  expect(extracted.images?.[0]?.bytes.length).toBeGreaterThan(1000);
  await expect(binaryText(Buffer.from("not a PDF"), "pdf", signal())).rejects.toThrow("not a PDF");
});

test("local OCR finds a synthetic email and solid redaction removes its pixels", async () => {
  const image = await imageFixture();
  const ocr = await runOcr(image, { engine: "tesseract", timeoutMs: 20000 });
  expect(ocr.regions.map(region => region.text).join(" ")).toContain("privacy@example.test");
  const found = await detectPii({ imageBytes: image, viewport: { width: 1200, height: 280 }, deviceScaleFactor: 1, ocrRegions: ocr.regions }, { keepMatchedText: false });
  expect(found.detections.some(detection => detection.category === "email")).toBe(true);
  expect(JSON.stringify(found)).not.toContain("privacy@example.test");
  const redacted = await redactPii({ imageBytes: image, detections: found.detections, width: 1200, height: 280 }, { blackout: true, paddingPx: 6 });
  expect(redacted.summary.regionsRedacted).toBeGreaterThan(0);
  const after = await runOcr(redacted.bytes, { engine: "tesseract", timeoutMs: 20000 });
  expect(after.regions.map(region => region.text).join(" ")).not.toContain("privacy@example.test");
});

test("media demux accepts valid streams and rejects over-limit recordings before AI calls", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "zipy-media-test-"));
  try {
    const video = path.join(directory, "silent.mp4"), long = path.join(directory, "long.wav");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=white:s=640x360:d=1", "-c:v", "libx264", video]);
    const extracted = await binaryText(await readFile(video), "mp4", signal());
    expect(extracted.images).toHaveLength(3); expect(extracted.audio).toBeUndefined();
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=181", "-ar", "16000", "-ac", "1", long]);
    await expect(binaryText(await readFile(long), "wav", signal())).rejects.toThrow("three minutes");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("@live-ai upload → worker → saved evidence for Office, image, mixed PDF, spoken audio and video", async ({ request, playwright, baseURL }) => {
  test.skip(process.env.ZIPY_LIVE_AI_TESTS !== "1", "Explicit opt-in: makes real, billable AI calls.");
  test.setTimeout(180000);
  registerObjectStoreDriver("local", async () => {
    const driver = new LocalObjectStoreDriver({
      root: path.resolve(import.meta.dirname, "../../artifacts/api-server", getConfig().storage.localRoot), isProduction: false,
    });
    await driver.init(); return driver;
  });
  const directory = await mkdtemp(path.join(tmpdir(), "zipy-live-media-"));
  const email = `media-fixture-${randomUUID()}@example.test`;
  const videoEmail = `video-fixture-${randomUUID()}@example.test`;
  const videoClient = await playwright.request.newContext({ baseURL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const jobs: string[] = [];
  const jobOwners = new Map<string, string>();
  let workspaceId = "";
  let videoWorkspaceId = "";
  try {
    const signed = await request.post("/api/auth/signup", { data: { email, password: `Fixture-${randomUUID()}-M1!` } });
    expect(signed.status(), await signed.text()).toBe(201);
    workspaceId = (await signed.json()).workspace.id;
    const created = await request.post("/api/suite/templates", { data: { action: "use", templateId: "starter-sop" } });
    const guideId = (await created.json()).id;
    // Four AI-based format groups exceed one free workspace's three-job
    // allowance. Use a separate synthetic tenant, never bypass live limits.
    const videoSigned = await videoClient.post("/api/auth/signup", { data: { email: videoEmail, password: `Fixture-${randomUUID()}-V1!` } });
    expect(videoSigned.status(), await videoSigned.text()).toBe(201);
    videoWorkspaceId = (await videoSigned.json()).workspace.id;
    const videoCreated = await videoClient.post("/api/suite/templates", { data: { action: "use", templateId: "starter-sop" } });
    const videoGuideId = (await videoCreated.json()).id;
    const image = await imageFixture();
    const imagePath = path.join(directory, "source.png");
    await sharp(image).toFile(imagePath);
    // Public-domain JFK speech, used by OpenAI Whisper's own test suite.
    const sample = await fetch("https://raw.githubusercontent.com/openai/whisper/main/tests/jfk.flac", { signal: AbortSignal.timeout(20000) });
    if (!sample.ok) throw new Error(`Public speech fixture unavailable (${sample.status}).`);
    const flacPath = path.join(directory, "speech.flac");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(flacPath, Buffer.from(await sample.arrayBuffer()));
    const wavPath = path.join(directory, "speech.wav"), videoPath = path.join(directory, "speech.mp4");
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-i", flacPath, "-ar", "16000", "-ac", "1", wavPath]);
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-loop", "1", "-i", imagePath, "-i", flacPath, "-vf", "scale=1200:-2", "-c:v", "libx264", "-c:a", "aac", "-shortest", videoPath]);
    const fixtures = [
      ...Object.entries(offices).map(([extension, buffer]) => ({ extension, buffer, mimeType: "application/octet-stream" })),
      { extension: "png", buffer: image, mimeType: "image/png" },
      { extension: "pdf", buffer: await mixedPdf(image), mimeType: "application/pdf" },
      { extension: "wav", buffer: await readFile(wavPath), mimeType: "audio/wav" },
      { extension: "mp4", buffer: await readFile(videoPath), mimeType: "video/mp4" },
    ];
    for (const fixture of fixtures) {
      const client = fixture.extension === "mp4" ? videoClient : request;
      const targetGuide = fixture.extension === "mp4" ? videoGuideId : guideId;
      const uploaded = await client.post(`/api/guides/${targetGuide}/sources`, { multipart: { file: { name: `synthetic-source.${fixture.extension}`, mimeType: fixture.mimeType, buffer: fixture.buffer } } });
      expect(uploaded.status(), await uploaded.text()).toBe(202);
      const id = (await uploaded.json()).jobId as string;
      jobs.push(id); jobOwners.set(id, fixture.extension === "mp4" ? videoWorkspaceId : workspaceId);
    }
    let sources: { jobId: string; status: string; text?: string; error?: string; extension?: string }[] = [];
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      sources = [
        ...(await (await request.get(`/api/guides/${guideId}/sources`)).json()).sources,
        ...(await (await videoClient.get(`/api/guides/${videoGuideId}/sources`)).json()).sources,
      ];
      const failed = sources.find(source => source.status === "failed");
      if (failed) throw new Error(`Media job ${failed.jobId} failed: ${failed.error}`);
      if (jobs.every(id => sources.some(source => source.jobId === id && source.status === "succeeded"))) break;
      await new Promise(resolve => setTimeout(resolve, 750));
    }
    expect(sources.filter(source => source.status === "succeeded")).toHaveLength(7);
    const byExtension = new Map(fixtures.map((fixture, index) => [fixture.extension, sources.find(source => source.jobId === jobs[index])!]));
    expect(byExtension.get("docx")?.text).toContain("settings & save");
    expect(byExtension.get("xlsx")?.text).toContain("English language");
    expect(byExtension.get("png")?.text?.toLowerCase()).toContain("settings");
    expect(byExtension.get("pdf")?.text).toContain("Searchable page");
    expect(byExtension.get("pdf")?.text?.toLowerCase()).toContain("synthetic");
    expect(byExtension.get("wav")?.text?.toLowerCase()).toContain("country");
    expect(byExtension.get("mp4")?.text?.toLowerCase()).toContain("country");
    expect(byExtension.get("mp4")?.text).toContain("Visual evidence");
    const videoJob = await getJob(videoWorkspaceId, byExtension.get("mp4")!.jobId);
    expect(videoJob?.result?.aiUsage).toMatchObject({ callCount: 2 });
    const pii = await request.post(`/api/guides/${guideId}/visuals`, { data: { action: "detect-pii", sourceJobId: byExtension.get("png")!.jobId } });
    expect(pii.status(), await pii.text()).toBe(200);
    const detection = await pii.json();
    expect(detection.detectionCount).toBeGreaterThan(0);
    expect(detection.marks.every((mark: { kind: string; x: number; y: number; w: number; h: number }) => mark.kind === "redact" && mark.x >= 0 && mark.y >= 0 && mark.x + mark.w <= 1 && mark.y + mark.h <= 1)).toBe(true);
    expect(JSON.stringify(detection)).not.toContain("privacy@example.test");
  } finally {
    for (const id of jobs) {
      const owner = jobOwners.get(id)!;
      const job = await getJob(owner, id);
      if (typeof job?.payload.sourceId === "string") await deleteMedia(owner, job.payload.sourceId);
    }
    for (const owner of [workspaceId, videoWorkspaceId].filter(Boolean)) {
      const store = await forWorkspace(owner);
      const keys: string[] = []; let cursor: string | null = null;
      do { const page = await store.list("", { limit: 250, cursor }); keys.push(...page.entries.map(entry => entry.key)); cursor = page.nextCursor; } while (cursor);
      for (const key of keys) await store.delete(key);
    }
    for (const address of [email, videoEmail]) {
      await pool.query("DELETE FROM workspaces WHERE created_by IN (SELECT id FROM users WHERE email_normalized=$1)", [address]);
      await pool.query("DELETE FROM users WHERE email_normalized=$1", [address]);
    }
    await pool.end(); await videoClient.dispose(); await rm(directory, { recursive: true, force: true });
  }
});
