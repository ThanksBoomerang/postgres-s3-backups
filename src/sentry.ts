import { randomUUID } from "crypto";

import { env } from "./env.js";

// Checks each backup in to a Sentry cron monitor over HTTP, so a backup that
// fails, hangs or never starts opens a Sentry issue:
// https://docs.sentry.io/product/crons/getting-started/http/
// Off without SENTRY_DSN. A check-in that cannot be sent is logged, never
// allowed to fail the backup.

type CheckInStatus = "in_progress" | "ok" | "error";

const monitorUrl = () => {
  if (!env.SENTRY_DSN) {
    return null;
  }
  try {
    const dsn = new URL(env.SENTRY_DSN);
    const projectId = dsn.pathname.replace(/^\//, "");
    return `${dsn.protocol}//${dsn.host}/api/${projectId}/cron/${env.SENTRY_MONITOR_SLUG}/${dsn.username}/`;
  } catch {
    console.log("SENTRY_DSN is not a valid DSN; not checking in to Sentry");
    return null;
  }
}

const monitorConfig = () => {
  const schedule = env.SENTRY_MONITOR_SCHEDULE || env.BACKUP_CRON_SCHEDULE;
  return {
    schedule: { type: "crontab", value: schedule },
    timezone: "UTC",
    // Minutes a check-in may be late before it counts as missed.
    checkin_margin: 30,
    // Minutes a backup may run before it counts as failed.
    max_runtime: 120,
    failure_issue_threshold: 1,
    recovery_threshold: 1,
  };
}

const sendCheckIn = async (checkInId: string, status: CheckInStatus) => {
  const url = monitorUrl();
  if (!url) {
    return;
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        check_in_id: checkInId,
        status,
        environment: process.env.RAILWAY_ENVIRONMENT_NAME || "production",
        monitor_config: monitorConfig(),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.log(`Sentry check-in (${status}) answered ${response.status}`);
    }
  } catch (error) {
    console.log(`Sentry check-in (${status}) failed:`, error);
  }
}

// Runs the job between an in_progress and an ok / error check-in.
export const monitored = async (job: () => Promise<void>) => {
  const checkInId = randomUUID();
  await sendCheckIn(checkInId, "in_progress");
  try {
    await job();
  } catch (error) {
    await sendCheckIn(checkInId, "error");
    throw error;
  }
  await sendCheckIn(checkInId, "ok");
}
