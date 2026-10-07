const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];

function findPdftotext(): string | null {
  return Bun.which("pdftotext", { PATH: [process.env.PATH ?? "", ...EXTRA_PATH].join(":") });
}

async function viaPdftotext(file: string, maxPages: number): Promise<string | null> {
  const bin = findPdftotext();
  if (!bin) return null;
  const proc = Bun.spawn([bin, "-l", String(maxPages), "-enc", "UTF-8", file, "-"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return code === 0 ? text : null;
}

export async function viaUnpdf(file: string, maxPages: number): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await Bun.file(file).arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: false });
    return text.slice(0, maxPages).join("\n");
  } catch {
    return "";
  }
}

/** Text layer of the first pages. Empty for scans; the caller falls back to OCR. */
export async function pdfText(file: string, maxPages = 2): Promise<string> {
  return (await viaPdftotext(file, maxPages)) ?? (await viaUnpdf(file, maxPages));
}

export const hasPdftotext = (): boolean => findPdftotext() !== null;
