import assert from "node:assert/strict";
import test from "node:test";
import { normalName, reconcile } from "./people.ts";

test("one person across GitHub, Linear and Jira gets one picture", () => {
  const people = reconcile([
    { ids: ["l:ada-acme", "e:ada@acme.test", "n:ada lovelace"], login: "ada-acme", name: "Ada Lovelace" }, // a commit
    { ids: ["e:ada@acme.test", "n:ada lovelace"], avatar: "https://linear.test/ada.png", name: "Ada Lovelace" }, // Linear
    { ids: ["e:bo@acme.test", "n:bo diddley"], avatar: "https://linear.test/bo.png", name: "Bo Diddley" },
  ]);
  const ada = people.find((person) => person.keys.includes("n:ada lovelace"));
  assert.equal(ada?.login, "ada-acme");
  assert.equal(ada?.avatar, "https://github.com/ada-acme.png?size=64"); // GitHub beats Linear
  assert.equal(people.find((person) => person.keys.includes("e:bo@acme.test"))?.avatar, "https://linear.test/bo.png");
  assert.equal(normalName("José  Núñez"), "jose nunez");
});

test("a Slack photo wins over GitHub", () => {
  const [person] = reconcile([
    { ids: ["l:cy", "e:cy@acme.test"], login: "cy" },
    { ids: ["e:cy@acme.test"], slack: "https://slack.test/cy.png" },
  ]);
  assert.equal(person.avatar, "https://slack.test/cy.png");
});
