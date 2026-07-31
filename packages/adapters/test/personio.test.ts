import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedJob } from "@hiring-signals/domain";
import type { SourceConfig } from "../src/adapter-contract";
import { PersonioSchemaError, parseFeedXml, personioAdapter } from "../src/personio";

// Personio's fixture is real XML text (unlike every other provider's JSON
// fixture), so it's read from disk instead of imported as a module -- see
// personio.ts's parseFeedXml header for why fetchBoard/tests share this
// same XML->object conversion step rather than hand-writing pre-parsed
// fixture objects.
function readFixture(name: string): string {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  return readFileSync(path, "utf-8");
}

const boardFixture = parseFeedXml(readFixture("personio-board.xml"));
const malformedFixture = parseFeedXml(readFixture("personio-board-malformed.xml"));

const source: SourceConfig = {
  sourceId: "src_1",
  companyId: "co_1",
  provider: "personio",
  boardToken: "examplecorp",
  publicUrl: "https://examplecorp.jobs.personio.de/",
};

function at(jobs: NormalizedJob[], i: number): NormalizedJob {
  const job = jobs[i];
  if (!job) throw new Error(`expected fixture job at index ${i}`);
  return job;
}

describe("parseFeedXml", () => {
  it("extracts every <position> block from the feed", () => {
    expect(boardFixture.positions).toHaveLength(3);
  });
});

describe("personioAdapter.normalize", () => {
  it("maps every position from the XML feed to a NormalizedJob", () => {
    const result = personioAdapter.normalize(boardFixture, source);
    expect(result).toHaveLength(3);
    expect(result.map((job) => job.title)).toContain("Senior Backend Engineer");
  });

  it("uses the numeric Personio position id as the external job id", () => {
    const first = at(personioAdapter.normalize(boardFixture, source), 0);
    expect(first.externalJobId).toBe("4103");
  });

  it("builds a canonical URL from the board host and job id, no query string", () => {
    // Verified 2026-07-31 against a real live Personio board
    // (fact-finder.jobs.personio.com/job/2704658): individual job links
    // are plain {host}/job/{id}, unlike the feed URL's ?language= param.
    const first = at(personioAdapter.normalize(boardFixture, source), 0);
    expect(first.canonicalUrl).toBe("https://examplecorp.jobs.personio.de/job/4103");
  });

  it("accepts a full custom career-site host as boardToken unchanged", () => {
    const customSource: SourceConfig = { ...source, boardToken: "careers.example.com" };
    const first = at(personioAdapter.normalize(boardFixture, customSource), 0);
    expect(first.canonicalUrl).toBe("https://careers.example.com/job/4103");
  });

  it("infers location mode from the office field", () => {
    const second = at(personioAdapter.normalize(boardFixture, source), 1);
    expect(second.locationRaw).toBe("Remote - Germany");
    expect(second.locationMode).toBe("remote");
  });

  it("infers onsite for a plain city office with no remote marker", () => {
    const first = at(personioAdapter.normalize(boardFixture, source), 0);
    expect(first.locationRaw).toBe("Munich");
    expect(first.locationMode).toBe("onsite");
  });

  it("treats an empty department tag as absent, not an empty string", () => {
    const second = at(personioAdapter.normalize(boardFixture, source), 1);
    expect(second.department).toBeUndefined();
  });

  it("maps createdAt to ISO-8601 UTC for both postedAt and updatedAt", () => {
    const first = at(personioAdapter.normalize(boardFixture, source), 0);
    expect(first.postedAt).toBe("2026-06-01T07:00:00.000Z");
    expect(first.updatedAt).toBe("2026-06-01T07:00:00.000Z");
  });

  it("treats a missing createdAt as unknown rather than current", () => {
    const second = at(personioAdapter.normalize(boardFixture, source), 1);
    expect(second.postedAt).toBeUndefined();
    expect(second.updatedAt).toBeUndefined();
  });

  it("joins jobDescription name/value pairs, unwrapping CDATA and HTML entities", () => {
    const first = at(personioAdapter.normalize(boardFixture, source), 0);
    expect(first.descriptionText).toContain("Your Role");
    expect(first.descriptionText).toContain("Build our core platform in TypeScript.");
    expect(first.descriptionText).toContain("Your Profile");
  });

  it("omits descriptionText when jobDescriptions is empty on an otherwise-valid position", () => {
    const third = at(personioAdapter.normalize(boardFixture, source), 2);
    expect(third.title).toBe("Support Specialist");
    expect(third.descriptionText).toBeUndefined();
  });

  it("throws PersonioSchemaError on a position missing required id/name fields", () => {
    expect(() => personioAdapter.normalize(malformedFixture, source)).toThrow(PersonioSchemaError);
  });

  it("throws on a payload missing the top-level positions array", () => {
    expect(() => personioAdapter.normalize({ nope: true }, source)).toThrow(PersonioSchemaError);
  });
});

describe("personioAdapter contract", () => {
  it("declares its provider as 'personio'", () => {
    expect(personioAdapter.provider).toBe("personio");
  });
});
