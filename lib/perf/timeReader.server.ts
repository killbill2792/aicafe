import "server-only";

/** Log reader name and elapsed milliseconds only; never log café or query data. */
export async function timeReader<T>(
  page: "Home" | "Money" | "Toast",
  name: string,
  read: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await read();
  } finally {
    console.info(`[reader-timing] ${page}.${name} ${Math.round(performance.now() - started)}ms`);
  }
}
