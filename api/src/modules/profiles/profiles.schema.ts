import { z } from "zod";

const Dimensions = z.object({
  width: z.number().int().min(1).describe("Viewport width"),
  height: z.number().int().min(1).describe("Viewport height"),
});

const Profile = z.object({
  id: z.string().uuid().describe("Unique profile ID"),
  projectId: z.string().uuid().optional().describe("Associated project ID"),
  status: z.string().describe("Profile status (e.g. READY, UPLOADING)"),
  dimensions: Dimensions.optional(),
  extensionIds: z.array(z.string()).optional(),
  credentialsConfig: z.record(z.unknown()).optional(),
  userDataDir: z.union([z.boolean(), z.string()]).optional(),
  proxyUrl: z.string().optional(),
  useProxy: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

const MultipleProfiles = z.object({
  count: z.number(),
  profiles: z.array(Profile),
});

const ProfileCreateRequest = z.object({
  userDataDir: z.any().describe("User data directory zip (binary, required)"),
  dimensions: z.string().optional().describe("JSON string of {height, width}"),
  projectId: z.string().uuid().optional(),
  proxyUrl: z.string().url().optional(),
  useProxy: z.string().optional().describe("JSON-encoded proxy configuration"),
});

export type Profile = z.infer<typeof Profile>;
export type MultipleProfiles = z.infer<typeof MultipleProfiles>;
export type ProfileCreateRequest = z.infer<typeof ProfileCreateRequest>;

export const profilesSchemas = {
  Dimensions,
  Profile,
  MultipleProfiles,
  ProfileCreateRequest,
};

export default profilesSchemas;
