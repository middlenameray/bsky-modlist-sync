// sync-lists.js
import { AtpAgent } from "@atproto/api";

const username = process.env.BSKY_USERNAME;
const password = process.env.BSKY_PASSWORD;

const SOURCE_LIST_URI =
  "at://did:plc:k3lft27u2pjqp2ptidkne7xr/app.bsky.graph.list/3lngcmewutk2z";

const MODLIST_NAME = "Verified Accounts (modlist)";
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 400;
const RETRY_DELAY_MS = 60 * 1000; // wait 60s on rate limit

async function fetchAllListItems(agent, listUri) {
  let items = [];
  let cursor = undefined;

  do {
    const res = await agent.app.bsky.graph.getList({
      list: listUri,
      limit: 100,
      cursor,
    });
    items.push(...res.data.items);
    cursor = res.data.cursor;
  } while (cursor);

  return items;
}

async function ensureModlist(agent, name) {
  const lists = await agent.com.atproto.repo.listRecords({
    repo: agent.session.did,
    collection: "app.bsky.graph.list",
  });

  const existing = lists.data.records.find(
    (r) =>
      r.value.name === name &&
      r.value.purpose === "app.bsky.graph.defs#modlist"
  );

  if (existing) {
    const rkey = existing.uri.split("/").pop();
    const uri = `at://${agent.session.did}/app.bsky.graph.list/${rkey}`;
    console.log("✅ Found existing modlist:", uri);
    return uri;
  }

  const res = await agent.com.atproto.repo.createRecord({
    repo: agent.session.did,
    collection: "app.bsky.graph.list",
    record: {
      $type: "app.bsky.graph.list",
      purpose: "app.bsky.graph.defs#modlist",
      name,
      description: "Auto-synced verified account modlist",
      createdAt: new Date().toISOString(),
    },
  });

  const rkey = res.data.uri.split("/").pop();
  const uri = `at://${agent.session.did}/app.bsky.graph.list/${rkey}`;
  console.log("🆕 Created new modlist:", uri);
  return uri;
}

// Sleep helper
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wrap API calls with automatic retry on rate-limit, with a graceful exit
let rateLimitHits = 0;
const MAX_RATE_LIMIT_HITS = 3;

async function safeCall(fn, ...args) {
  while (true) {
    try {
      const result = await fn(...args);
      rateLimitHits = 0; // reset after successful call
      return result;
    } catch (err) {
      if (
        err.error === "RateLimitExceeded" ||
        (err.message && err.message.includes("RateLimitExceeded"))
      ) {
        rateLimitHits++;
        console.warn(`⚠️ Rate limit hit (#${rateLimitHits}). Waiting ${RETRY_DELAY_MS / 1000}s before retry...`);

        // If we've hit rate limit too many times, exit gracefully
        if (rateLimitHits >= MAX_RATE_LIMIT_HITS) {
          console.warn("⚠️ Too many rate limit hits in a row. Exiting early to retry later.");
          process.exit(0); // graceful exit, GitHub Actions treats this as success
        }

        await sleep(RETRY_DELAY_MS);
      } else if (err.message && err.message.includes("duplicate")) {
        return; // already added, ignore
      } else {
        console.error("Unexpected error:", err);
        throw err;
      }
    }
  }
}

async function addToModlist(agent, listUri, did) {
  await safeCall(
    agent.com.atproto.repo.createRecord.bind(agent.com.atproto.repo),
    {
      repo: agent.session.did,
      collection: "app.bsky.graph.listitem",
      record: {
        $type: "app.bsky.graph.listitem",
        subject: did,
        list: listUri,
        createdAt: new Date().toISOString(),
      },
    }
  );
  console.log("Added:", did);
}

async function removeFromModlist(agent, listUri, did) {
  const records = await agent.com.atproto.repo.listRecords({
    repo: agent.session.did,
    collection: "app.bsky.graph.listitem",
  });

  const rec = records.data.records.find(
    (r) => r.value.subject === did && r.value.list === listUri
  );
  if (!rec) return;

  await safeCall(
    agent.com.atproto.repo.deleteRecord.bind(agent.com.atproto.repo),
    {
      repo: agent.session.did,
      collection: "app.bsky.graph.listitem",
      rkey: rec.uri.split("/").pop(),
    }
  );
  console.log("Removed:", did);
}

async function main() {
  const agent = new AtpAgent({ service: "https://bsky.social" });
  await agent.login({ identifier: username, password });

  const modlistUri = await ensureModlist(agent, MODLIST_NAME);

  const curatelistItems = await fetchAllListItems(agent, SOURCE_LIST_URI);
  const curatelistDIDs = curatelistItems.map((i) => i.subject.did);

  const modlistItems = await fetchAllListItems(agent, modlistUri);
  const modlistDIDs = modlistItems.map((i) => i.subject.did);

  let addedCount = 0;
  let removedCount = 0;

  const toAdd = curatelistDIDs.filter((did) => !modlistDIDs.includes(did));
  const toRemove = modlistDIDs.filter((did) => !curatelistDIDs.includes(did));

  // Batch add
  for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
    const batch = toAdd.slice(i, i + BATCH_SIZE);
    for (const did of batch) {
      await addToModlist(agent, modlistUri, did);
    }
    addedCount += batch.length;
    await sleep(BATCH_DELAY_MS);
  }

  // Batch remove
  for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
    const batch = toRemove.slice(i, i + BATCH_SIZE);
    for (const did of batch) {
      await removeFromModlist(agent, modlistUri, did);
    }
    removedCount += batch.length;
    await sleep(BATCH_DELAY_MS);
  }

  console.log(`✅ Sync complete (${addedCount} added, ${removedCount} removed).`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
