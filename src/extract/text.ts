export async function plainText(file: string, maxBytes = 16_384): Promise<string> {
  return Bun.file(file).slice(0, maxBytes).text();
}
