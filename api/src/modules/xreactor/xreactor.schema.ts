import { FastifyRequest } from "fastify";
import { z } from "zod";

/** Hard cap on URLs per request (each URL runs its own browser session). */
export const MAX_URLS_PER_REQUEST = 25;

const urlOrUrls = z.union([z.string().min(1), z.array(z.string()).min(1)]);

const XReactorCheckRequest = z
  .object({
    url: urlOrUrls
      .optional()
      .describe(
        "Page URL to check — either a single string or an array of URLs for batch checks",
      ),
    urls: z
      .array(z.string())
      .optional()
      .describe("Alternative to `url`: an array of page URLs to check"),
  })
  .refine((body) => Boolean(body.url) || Boolean(body.urls?.length), {
    message: "Provide `url` (string or array) or `urls` (array)",
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

/** Result for ONE checked URL (same shape as before). */
const XReactorSingleResult = z.object({
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
  error: z.string().optional(),
});

/** Response shape when MORE than one URL was requested. */
const XReactorMultiResult = z.object({
  results: z.array(XReactorSingleResult),
  summary: z.object({
    total: z.number().int(),
    allowed: z.number().int(),
    disallowed: z.number().int(),
    pagesErrored: z.number().int(),
    totalMs: z.number().int(),
  }),
});

const XReactorResponse = z.union([XReactorSingleResult, XReactorMultiResult]);

export type XReactorCheckBody = z.infer<typeof XReactorCheckRequest>;
export type XReactorRequest = FastifyRequest<{ Body: XReactorCheckBody }>;

export const xreactorSchemas = {
  XReactorCheckRequest,
  XReactorVerdict,
  XReactorPageVerdict,
  XReactorSingleResult,
  XReactorMultiResult,
  XReactorResponse,
};

export default xreactorSchemas;
