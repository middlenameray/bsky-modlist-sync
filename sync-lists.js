// sync-lists.js
import { AtpAgent } from "@atproto/api";

const username = process.env.BSKY_USERNAME;
const password = process.env.BSKY_PASSWORD;

// The verified accounts curatelist you want to mirror
const SOURCE_LIST_URI = "at://did:plc:k3lft27u2pjqp2ptidkne7xr/app.bsky.graph.list/3lngcmewutk2z";
// Name for your modlist
const MODLIST_NAME = "Verified Accounts (modlist)";

async function ensureModlist(agent, name) {
  const lists = await agent.com.atproto.repo.listRecords({
    repo: agent.session.did,
    collection: "app.bsky.graph.list",
  });

  const existing = lists.data.records.find(
    (r) => r.value.name === name && r.value.purpose === "app.bsky.graph.defs#modlist"
  );

  if (existing) {
    console.log("Found existing modlist:", existing.uri);
    return existing.uri;
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

  console.log("Created new modlist:", res.uri);
  return res.uri;
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

  // fetch curatelist
  const curatelist = await agent.app.bsky.graph.getList({ list: SOURCE_LIST_URI });
  const curatelistDIDs = curatelist.data.items.map((i) => i.subject.did);

  // fetch modlist
  const modlist = await agent.app.bsky.graph.getList({ list: modlistUri });
  const modlistDIDs = modlist.data.items.map((i) => i.subject.did);

  // sync adds
  for (const did of curatelistDIDs) {
    if (!modlistDIDs.includes(did)) {
      await addToModlist(agent, modlistUri, did);
    }
  }

  // sync removals
  for (const did of modlistDIDs) {
    if (!curatelistDIDs.includes(did)) {
      await removeFromModlist(agent, modlistUri, did);
    }
  }

  console.log("✅ Sync complete.");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
