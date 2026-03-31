export type MessageValue = string | number | boolean | Date | null | undefined;

const TEMPLATE_PATTERN = /\{(\w+)\}/g;

export function formatMessage(template: string, values: Record<string, MessageValue> = {}): string {
  return template.replace(TEMPLATE_PATTERN, (_match, key: string) => {
    if (!(key in values)) {
      return '';
    }
    const value = values[key];
    if (value == null) {
      return '';
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    return String(value);
  });
}
