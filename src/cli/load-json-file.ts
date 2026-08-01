export async function loadJsonFile(
  path?: string,
): Promise<unknown | undefined> {
  if (!path) return undefined;
  const text = await Bun.file(path).text();
  return JSON.parse(text);
}
