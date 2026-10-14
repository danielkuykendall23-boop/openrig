// `rig policy apply <name> --seat <seat>`: a seat's permission_policy can change after the rig was
// instantiated. Restore, resume and lifecycle launches read the seat's STORED attachment, never the
// spec file, so editing the spec alone never reached an existing seat.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { createTestApp, migrationsForFullTestDb } from "./helpers/test-app.js";
import type { Hono } from "hono";
import type { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { validatePermissionPolicyRef } from "../src/domain/permission-policy/policy-ref.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { OmpResumeAdapter } from "../src/adapters/omp-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";

function agentYaml(name: string): string {
  return `name: ${name}\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []`;
}

const fsOps = {
  readFile: (p: string) => {
    if (p.includes("agents/builder")) return agentYaml("builder");
    throw new Error(`Not found: ${p}`);
  },
  exists: (p: string) => p.includes("agents/builder"),
};

function spec(name: string, builderPolicy?: string): Record<string, unknown> {
  return {
    version: "0.2",
    name,
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "builder", agent_ref: "local:agents/builder", profile: "default", runtime: "omp", cwd: ".",
        ...(builderPolicy ? { permission_policy: builderPolicy } : {}),
      }],
      edges: [],
    }],
    edges: [],
  };
}

function mockTmux(): TmuxAdapter {
  return mockShellCommand({
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "omp"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    hasSession: vi.fn(async () => false),
  } as unknown as TmuxAdapter);
}

let dir: string;
let db: Database.Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "policy-existing-seat-"));
  db = createDb(join(dir, "d.sqlite"));
  migrate(db, migrationsForFullTestDb);
});
afterEach(() => {
  if (db.open) db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function materialize(setup: { podInstantiator: PodRigInstantiator; rigRepo: RigRepository }, name: string, builderPolicy?: string) {
  const outcome = await setup.podInstantiator.materializeStructured(spec(name, builderPolicy), "/project/rigs/spark");
  if (!outcome.ok) throw new Error(`materialize failed: ${JSON.stringify(outcome)}`);
  const rigId = outcome.result.rigId;
  const builder = setup.rigRepo.getRig(rigId)!.nodes.find((n) => n.logicalId === "dev.builder")!;
  return { rigId, builder };
}

async function applyToSeat(setup: { app: Hono }, seat: string, body: Record<string, unknown>) {
  const res = await setup.app.request(`/api/seat/set-policy/${encodeURIComponent(seat)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: "builder needs to run unattended", operator: "operator@spark", ...body }),
  });
  const json: Record<string, unknown> = await res.json();
  return { status: res.status, body: json };
}
describe("rig policy apply --seat: an existing seat's policy reaches its next launch", () => {
  it("an OMP seat created with no policy restores at full_bypass after builtin:yolo is applied to it", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    // A seat created with no policy: nothing is attached, so every launch path binds the floor.
    // (No pod: the legacy resume path is the one a test can drive without a live runtime; the pod-aware
    // path reads the same RestoreOrchestrator.resolveRestorePosture.)
    const rigId = setup.rigRepo.createRig("spark-rig").id;
    const builder = setup.rigRepo.addNode(rigId, "dev.builder", { runtime: "omp", cwd: "/w" });
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toBeNull();
    const session = setup.sessionRegistry.registerSession(builder.id, "dev-builder@spark-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = 'omp_session_file', resume_token = '/state/builder.jsonl' WHERE id = ?").run(session.id);
    const snap = setup.snapshotCapture.captureSnapshot(rigId, "manual");

    const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "builtin:yolo" });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body).toMatchObject({ ok: true, changed: true, from: null, to: "builtin:yolo", launchPosture: "full_bypass" });

    // The stored seat now carries exactly what instantiating `permission_policy: builtin:yolo` stores.
    const reference = await materialize(setup, "reference-rig", "builtin:yolo");
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toEqual(setup.rigRepo.getNodePolicyProvenance(reference.builder.id));
    // The seat's own ref (what export and `rig seat status` read) is the new one too.
    expect(setup.rigRepo.getRig(rigId)!.nodes.find((n) => n.id === builder.id)!.permissionPolicy).toBe("builtin:yolo");
    const event = db.prepare("SELECT payload FROM events WHERE type = 'node.policy_changed'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ nodeId: builder.id, from: null, to: "builtin:yolo", reason: "builder needs to run unattended", operator: "operator@spark" });

    // The next restore hands the resume adapter the new posture (OMP: --approval-mode yolo).
    const tmux = mockTmux();
    const ompResume = {
      canResume: vi.fn((type: string | null) => type === "omp_session_file"),
      resume: vi.fn(async () => ({ ok: true as const })),
    } as unknown as OmpResumeAdapter;
    const orch = new RestoreOrchestrator({
      db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, eventBus: setup.eventBus,
      snapshotRepo: setup.snapshotRepo, snapshotCapture: setup.snapshotCapture, checkpointStore: setup.checkpointStore,
      nodeLauncher: new NodeLauncher({ db, rigRepo: setup.rigRepo, sessionRegistry: setup.sessionRegistry, eventBus: setup.eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
      ompResume,
    });
    await orch.restore(snap.id);
    const call = vi.mocked(ompResume.resume).mock.calls.find((c) => c[2] === "/state/builder.jsonl");
    expect(call, "the builder's resume should have been attempted").toBeDefined();
    expect(call![5]).toBe("full_bypass");
  });

  it("validates the ref exactly like a spec does and changes nothing on refusal", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    const { builder } = await materialize(setup, "spark-rig");
    setup.sessionRegistry.registerSession(builder.id, "dev-builder@spark-rig");
    for (const ref of ["yolo", "builtin:mystery", "../escape.md", ""]) {
      const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref });
      expect(applied.status).toBe(400);
      expect(applied.body).toMatchObject({ ok: false, code: "invalid_policy", message: validatePermissionPolicyRef(ref, "permission_policy") });
    }
    // A custom policy file resolves relative to the spec that declares it; a seat has no such directory.
    const custom = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "policies/operator.md" });
    expect(custom).toMatchObject({ status: 400, body: { ok: false, code: "invalid_policy" } });
    expect(String(custom.body["message"])).toContain("rig spec");
    const noReason = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "builtin:yolo", reason: " " });
    expect(noReason).toMatchObject({ status: 400, body: { ok: false, code: "missing_reason" } });
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.policy_changed'").get()).toEqual({ n: 0 });
  });

  it("refuses a terminal seat, as spec validation does", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    const rig = setup.rigRepo.createRig("term-rig");
    const terminal = setup.rigRepo.addNode(rig.id, "dev.shell", { runtime: "terminal", cwd: "/w" });
    setup.sessionRegistry.registerSession(terminal.id, "dev-shell@term-rig");
    const applied = await applyToSeat(setup, "dev-shell@term-rig", { ref: "builtin:yolo" });
    expect(applied).toMatchObject({ status: 400, body: { ok: false, code: "invalid_policy" } });
    expect(String(applied.body["message"])).toContain("not valid on terminal members");
    expect(setup.rigRepo.getNodePolicyProvenance(terminal.id)).toBeNull();
  });

  it("records `none` as the deliberate choice (not absence) and an unchanged re-apply is a no-op", async () => {
    const setup = createTestApp(db, { podInstantiatorFsOps: fsOps });
    const { builder } = await materialize(setup, "spark-rig", "builtin:yolo");
    setup.sessionRegistry.registerSession(builder.id, "dev-builder@spark-rig");
    const applied = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "none" });
    expect(applied).toMatchObject({ status: 200, body: { ok: true, changed: true, from: "builtin:yolo", to: "none", launchPosture: "floor" } });
    const reference = await materialize(setup, "reference-rig", "none");
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toEqual(setup.rigRepo.getNodePolicyProvenance(reference.builder.id));
    expect(setup.rigRepo.getNodePolicyProvenance(builder.id)).toMatchObject({ origin: "deliberate_none", nodeRef: "none" });

    const again = await applyToSeat(setup, "dev-builder@spark-rig", { ref: "none" });
    expect(again).toMatchObject({ status: 200, body: { ok: true, changed: false } });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.policy_changed'").get()).toEqual({ n: 1 });
  });
});
