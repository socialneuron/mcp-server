export interface PluginValidation {
  errors: string[];
  warnings: string[];
}
export function validatePlugin(repoRoot?: string): Promise<PluginValidation>;
export function parseFrontmatter(
  text: string,
): { fields: Record<string, string>; body: string } | null;
