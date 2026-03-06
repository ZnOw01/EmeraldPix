export type MessageValue = string | number | boolean | Date | null | undefined;

export function formatMessage(
  template: string,
  values: Record<string, MessageValue> = {}
): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === null || value === undefined) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value);
  });
}
