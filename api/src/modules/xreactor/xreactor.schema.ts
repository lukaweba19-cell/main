import { FastifyRequest } from "fastify";
import { z } from "zod";

const XReactorCheckRequest = z.object({
  url: z.string().min(1).describe("The page URL to check for cloud mentions"),
});

const XReactorVerdict = z.object({
  variant: z.string(),
  excerpt: z.string(),
});

const XReactorPageVerdict = z.object({
  url: z.string(),
  finalUrl: z.string().nullable(),
  status: z.enum(["ok", "error", "skipped"]),
  cloudFound: z.boolean(),
  matches: z.array(XReactorVerdict),
  markdownChars: z.number().int(),
  error: z.string().optional(),
  followedFrom: z.string().nullable(),
});

const XReactorResponse = z.object({
  result: z.enum(["allowed", "disallowed"]),
  seedUrl: z.string(),
  pages: z.array(XReactorPageVerdict),
  links: z.object({
    found: z.number().int(),
    followed: z.array(z.string()),
    skippedAds: z.number().int(),
    skippedBinary: z.number().int(),
    skippedOther: z.number().int(),
  }),
  timings: z.object({
    totalMs: z.number().int(),
  }),
});

export type XReactorCheckBody = z.infer<typeof XReactorCheckRequest>;
export type XReactorRequest = FastifyRequest<{ Body: XReactorCheckBody }>;

export const xreactorSchemas = {
  XReactorCheckRequest,
  XReactorVerdict,
  XReactorPageVerdict,
  XReactorResponse,
};

export default xreactorSchemas;
