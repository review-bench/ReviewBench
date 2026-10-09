import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface OnboardingOptions {
  dataset: string;
  output: string;
  agent?: string;
  model?: string;
  customAgent?: boolean;
  environment: "docker" | "daytona" | "modal" | "e2b";
}

export function createOnboardingKit(opts: OnboardingOptions, root = ROOT): void {
  const dataset = resolve(opts.dataset);
  const output = resolve(opts.output);
  if (existsSync(output)) throw new Error("Output already exists; choose a new kit directory");
  if (!existsSync(join(dataset, "dataset.toml")) || !existsSync(join(dataset, "metric.py"))) {
    throw new Error("Use an approved ReviewBench export containing dataset.toml and metric.py");
  }
  const tasks = readdirSync(dataset, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory() && existsSync(join(dataset, entry.name, "task.toml")));
  if (!tasks.length) throw new Error("The approved dataset has no tasks");
  if (opts.customAgent ? Boolean(opts.agent) : !opts.agent) {
    throw new Error("Select either --agent or --custom-agent");
  }
  if (opts.agent && !/^[a-z][a-z0-9-]*$/.test(opts.agent)) {
    throw new Error("Built-in agent name must contain lowercase letters, digits, and hyphens");
  }
  if (opts.agent && !opts.model) throw new Error("Specify the reviewer --model as provider/model");
  if (opts.model !== undefined && !/^[^\s/]+\/[^\s]+$/.test(opts.model)) {
    throw new Error("Reviewer model must be provider/model");
  }
  if (!["docker", "daytona", "modal", "e2b"].includes(opts.environment)) {
    throw new Error("Select a supported environment: docker, daytona, modal, or e2b");
  }
  const agent = {
    ...(opts.customAgent ? { import_path: "custom_agent:CustomReviewAgent" } : { name: opts.agent }),
    ...(opts.model ? { model_name: opts.model } : {}),
  };
  const config = {
    job_name: "reviewbench",
    jobs_dir: join(output, "jobs"),
    datasets: [{ path: dataset }],
    agents: [agent],
    environment: { type: opts.environment },
    n_attempts: 1,
    n_concurrent_trials: 1,
    metrics: [{ type: "uv-script", kwargs: { script_path: join(dataset, "metric.py") } }],
  };
  const readme = readFileSync(join(root, "scripts", "harbor", "onboarding", "README.md"), "utf8");
  const adapter = readFileSync(join(root, "scripts", "harbor", "onboarding", "custom_agent.py"), "utf8");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "job.json"), JSON.stringify(config, null, 2) + "\n");
  writeFileSync(join(output, "custom_agent.py"), adapter);
  writeFileSync(join(output, "README.md"), readme);
  writeFileSync(join(output, "kit.json"), JSON.stringify({
    schema_version: 1,
    dataset,
    task_count: tasks.length,
    agent,
    environment: opts.environment,
    changes_judge_or_tasks: false,
    contains_credentials: false,
  }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      dataset: { type: "string" }, output: { type: "string" },
      agent: { type: "string" }, model: { type: "string" },
      "custom-agent": { type: "boolean", default: false },
      environment: { type: "string", default: "docker" },
    } });
    if (!values.dataset || !values.output) throw new Error("--dataset and --output are required");
    const environment = values.environment;
    if (environment !== "docker" && environment !== "daytona" &&
        environment !== "modal" && environment !== "e2b") {
      throw new Error("--environment must be docker, daytona, modal, or e2b");
    }
    createOnboardingKit({
      dataset: values.dataset, output: values.output, agent: values.agent, model: values.model,
      customAgent: values["custom-agent"],
      environment,
    });
    console.log(`Created user kit at ${resolve(values.output)}. No credentials or dataset assets copied.`);
  } catch (error) {
    console.error("Harbor onboarding failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
