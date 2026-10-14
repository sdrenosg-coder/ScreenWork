/**
 * The imported snapshot has routes referring to functions its libraries do not
 * export. Do not fabricate their behavior or stop unrelated endpoints booting.
 */
export function requireImportedFunction(
  module: object,
  name: string,
  moduleName: string,
): (...args: any[]) => any {
  return (...args: any[]) => {
    const implementation = (module as Record<string, unknown>)[name];
    if (typeof implementation !== "function") {
      throw new Error(`Imported feature unavailable: ${moduleName} did not include ${name}.`);
    }
    return implementation(...args);
  };
}
