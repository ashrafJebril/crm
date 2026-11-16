/** SP-10 catalog and catalog-import API calls (the shared client: token, 401, errors). */
import { api } from "@/api/client";
import type {
  CatalogDeleteResult,
  CatalogImport,
  Service,
  ServiceDeletePreview,
  StaffDeletePreview,
  StaffResource,
  WeeklySchedule,
} from "@/lib/types";
import { saveBlob } from "@/screens/contacts/import/importApi";

export interface ServiceInput {
  name?: string;
  nameAr?: string;
  durationMin?: number;
  price?: string | null;
  currency?: string;
  color?: string;
  active?: boolean;
  staffIds?: string[];
  version?: number;
}

export interface StaffInput {
  name?: string;
  nameAr?: string | null;
  role?: string | null;
  color?: string;
  userId?: string | null;
  schedule?: WeeklySchedule;
  active?: boolean;
  serviceIds?: string[];
  version?: number;
}

export const servicesPath = (archived: boolean) => (archived ? "/services" : "/services?active=true");
export const staffPath = (archived: boolean) => (archived ? "/staff" : "/staff?active=true");

export const createService = (body: ServiceInput) => api.post<Service>("/services", body);
export const updateService = (id: string, body: ServiceInput) => api.patch<Service>(`/services/${id}`, body);
export const setServiceStaff = (id: string, staffIds: string[]) => api.put<Service>(`/services/${id}/staff`, { staffIds });
export const servicePreview = (id: string) => api.get<ServiceDeletePreview>(`/services/${id}/delete-preview`);
export const deleteService = (id: string) => api.delete<CatalogDeleteResult>(`/services/${id}`);
export const restoreService = (id: string) => api.post<Service>(`/services/${id}/restore`);

export const createStaff = (body: StaffInput) => api.post<StaffResource>("/staff", body);
export const updateStaff = (id: string, body: StaffInput) => api.patch<StaffResource>(`/staff/${id}`, body);
export const setStaffServices = (id: string, serviceIds: string[]) => api.put<StaffResource>(`/staff/${id}/services`, { serviceIds });
export const staffPreview = (id: string) => api.get<StaffDeletePreview>(`/staff/${id}/delete-preview`);
export const deleteStaff = (id: string) => api.delete<CatalogDeleteResult>(`/staff/${id}`);
export const restoreStaff = (id: string) => api.post<StaffResource>(`/staff/${id}/restore`);

export type ImportKind = "auto" | "services" | "staff";

export const startPasteImport = (text: string, kind: ImportKind) =>
  api.post<CatalogImport>("/catalog-imports", { source: "paste", text, kind });
export const startUrlImport = (url: string, kind: ImportKind) =>
  api.post<CatalogImport>("/catalog-imports", { source: "url", url, kind });
export function startFileImport(file: File, kind: ImportKind): Promise<CatalogImport> {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("file", file);
  return api.postForm<CatalogImport>("/catalog-imports", fd);
}
export const getCatalogImport = (id: string) => api.get<CatalogImport>(`/catalog-imports/${id}`);
export const patchImportItems = (id: string, items: { key: string; selected?: boolean; data?: Record<string, unknown> }[]) =>
  api.patch<CatalogImport>(`/catalog-imports/${id}/items`, { items });
export const runCatalogImport = (id: string) => api.post<CatalogImport>(`/catalog-imports/${id}/run`);
export const cancelCatalogImport = (id: string) => api.post<CatalogImport>(`/catalog-imports/${id}/cancel`);

export async function downloadTemplate(kind: "services" | "staff"): Promise<void> {
  const { blob, filename } = await api.getBlob(`/catalog-imports/templates/${kind}`);
  saveBlob(blob, filename ?? `catalog-${kind}-template.xlsx`);
}
