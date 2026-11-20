export const productIds = ['PL-100', 'AL-200'] as const;
export type ProductId = (typeof productIds)[number];
