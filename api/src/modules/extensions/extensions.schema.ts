import { z } from "zod";

const Extension = z.object({
  id: z.string().uuid().describe("Unique identifier for the extension"),
  name: z.string().describe("Name of the extension"),
  createdAt: z.string().datetime().describe("Timestamp when the extension was created"),
  updatedAt: z.string().datetime().describe("Timestamp when the extension was last updated"),
});

const MultipleExtensions = z.object({
  count: z.number().describe("Total number of extensions"),
  extensions: z.array(Extension).describe("Array of extension objects"),
});

const ExtensionMessage = z.object({
  message: z.string().describe("Status message"),
});

const ExtensionUploadRequest = z.object({
  file: z.any().optional().describe("Chrome extension .zip or .crx file (binary)"),
  url: z.string().url().optional().describe("Chrome Web Store URL or direct download URL"),
});

export type Extension = z.infer<typeof Extension>;
export type MultipleExtensions = z.infer<typeof MultipleExtensions>;
export type ExtensionMessage = z.infer<typeof ExtensionMessage>;
export type ExtensionUploadRequest = z.infer<typeof ExtensionUploadRequest>;

export const extensionsSchemas = {
  Extension,
  MultipleExtensions,
  ExtensionMessage,
  ExtensionUploadRequest,
};

export default extensionsSchemas;
