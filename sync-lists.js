// sync-lists.js
import { AtpAgent } from "@atproto/api";

const username = process.env.BSKY_USERNAME;
const password = process.env.BSKY_PASSWORD;

// Verified accounts curatelist to mirror
const SOURCE_LIST_URI =
  "at://did:plc:k3lft27u2pjqp2ptidkne7xr/app.bsky.graph.list/3lngcmewutk2z";

// Name for your modlist
const MODLIST_NAME = "Verified Accounts (modlist)";
const BATCH_SIZE = 25; // adjust batch size if needed

// Fetch all items from a list with pagination
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

async function addToModlist(agent, listUri, did) {
  try {
    await agent.com.atproto.repo.createRecord({
      repo: agent.session.did,
      collection: "app.bsky.graph.listitem",
      record: {
        $type: "app.bsky.graph.listitem",
        subject: did,
        list: listUri,
        createdAt: new Date().toISOString(),
      },
    });
    console.log("Added:", did);
  } catch (err) {
    if (err.message.includes("duplicate")) {
      console.log("Already present:", did);
    } else {
      console.error("Add error:", err);
    }
  }
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

  await agent.com.atproto.repo.deleteRecord({
    repo: agent.session.did,
    collection: "app.bsky.graph.listitem",
    rkey: rec.uri.split("/").pop(),
  });
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

  // Prepare batches
  const toAdd = curatelistDIDs.filter((did) => !modlistDIDs.includes(did));
  const toRemove = modlistDIDs.filter((did) => !curatelistDIDs.includes(did));

  // Batch add
  for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
    const batch = toAdd.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((did) => addToModlist(agent, modlistUri, did)));
    addedCount += batch.length;
  }

  // Batch remove
  for (let i = 0; i < toRemove.length; i += BATCH_SIZE) {
    const batch = toRemove.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((did) => removeFromModlist(agent, modlistUri, did)));
    removedCount += batch.length;
  }

  console.log(`✅ Sync complete (${addedCount} added, ${removedCount} removed).`);
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
