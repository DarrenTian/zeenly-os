import {
  type Actor,
  createUnit,
  type Database,
  db as defaultDb,
} from "@zeenly-os/core";

/**
 * A one-person company to start from. The roles are the ones most such
 * companies have; each charter says what the role owns and where it stops,
 * which is what its agent reads first. Everything here is a starting point
 * for the person to edit, not a rule.
 */
export type RoleTemplate = {
  id: string;
  name: string;
  summary: string;
  charter: string;
};

export const ROLES: RoleTemplate[] = [
  {
    id: "engineering",
    name: "Engineering",
    summary: "Builds and runs the product",
    charter: `## Owns
- The product's code, its tests, its deploys and its uptime.
- Technical decisions inside the product: architecture, dependencies, data.

## Doesn't own
- What to build or for whom: that comes down as directives.
- Anything customers see or receive before it ships: say what will change and wait.
- Spending money (new services, paid tiers): escalate.

## How it works
- Small, reviewable changes, each with tests. Nothing lands without them passing.
- When a change touches what customers see, say so in the report.`,
  },
  {
    id: "marketing",
    name: "Marketing",
    summary: "Finds the people the product is for and tells them",
    charter: `## Owns
- Who the customers are, where they are, and what we say to them.
- The website's words, the launch posts, the outreach drafts.

## Doesn't own
- Publishing anything, sending anything to anyone, or spending on ads: draft it, report it, wait for the go-ahead.
- Promises about the product that engineering hasn't confirmed.

## How it works
- Every claim in a draft is something the product does today.
- Report what was drafted and what it's waiting on.`,
  },
  {
    id: "finance",
    name: "Finance",
    summary: "Knows what comes in, what goes out, and what's left",
    charter: `## Owns
- The books: revenue, costs, runway, and what each role is spending.
- Flagging when a plan costs more than it brings in.

## Doesn't own
- Paying, pricing, or signing anything: recommend, escalate.
- Any account's credentials.

## How it works
- Numbers come from statements and invoices, never estimates presented as actuals.
- Report in numbers first, words second.`,
  },
];

const SLUG = /[^a-z0-9]+/g;

/** A unit id from a company name: lower-case, dashes, 2–40 characters. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(SLUG, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug.length >= 2 && /^[a-z]/.test(slug) ? slug : "company";
}

/**
 * Creates the company: a root the person steers, with the roles they picked
 * under it on autopilot, so they act and escalate to the person what they
 * can't settle.
 */
export async function createCompany(
  input: { company: string; person: string; roles: string[]; charter?: string },
  database: Database = defaultDb(),
): Promise<{ root: string; person: Actor; roles: string[] }> {
  const person: Actor = { kind: "human", id: input.person };
  const root = slugOf(input.company);
  await createUnit(
    {
      id: root,
      name: input.company.trim(),
      summary: "The company",
      charter:
        input.charter?.trim() ||
        `## Owns\n- The whole company: its direction, its roles, and what each may do.\n\n## How it works\n- Directives go down from here; what the roles can't settle climbs back up to ${input.person}.`,
      owner: input.person,
      mode: "steer",
    },
    person,
    {},
    database,
  );
  const made: string[] = [];
  for (const role of ROLES.filter((r) => input.roles.includes(r.id))) {
    await createUnit(
      {
        id: role.id,
        parentId: root,
        name: role.name,
        summary: role.summary,
        charter: role.charter,
        mode: "autopilot",
      },
      person,
      {},
      database,
    );
    made.push(role.id);
  }
  return { root, person, roles: made };
}
