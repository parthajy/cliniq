export function log(scope: string, msg: string, data?: any) {
  const base = `[WORKER][${scope}] ${msg}`;
  if (data !== undefined) console.log(base, data);
  else console.log(base);
}
