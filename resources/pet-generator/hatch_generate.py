#!/usr/bin/env python3
"""One-shot text-to-pet launcher for Alkaka.

This wraps the Codex Hatch Pet pipeline with a product-facing command:

    python3 resources/pet-generator/hatch_generate.py --prompt "a sleepy robot seedling"

It does not call the Image API directly and does not require OPENAI_API_KEY.
Instead it prepares a Hatch Pet run and asks the local Codex CLI to use its
built-in image generation capability, then install the result as an
Mia-compatible atlas package.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
import re
import shutil
import shlex
import subprocess
import sys
from pathlib import Path


GENERATOR_ROOT = Path(__file__).resolve().parent
REPO_ROOT = GENERATOR_ROOT
PETCTL = GENERATOR_ROOT / "petctl.py"
CODEX_HOME = Path(os.environ.get("CODEX_HOME") or "~/.codex").expanduser()
HATCH_SCRIPT_CANDIDATES = (
    GENERATOR_ROOT / "alkaka-friend-pet" / "scripts",
    GENERATOR_ROOT / "skills" / "alkaka-friend-pet" / "scripts",
    GENERATOR_ROOT.parent / "skills" / "alkaka-friend-pet" / "scripts",
    GENERATOR_ROOT.parent.parent / "skills" / "alkaka-friend-pet" / "scripts",
    CODEX_HOME / "skills" / "hatch-pet" / "scripts",
    CODEX_HOME
    / "vendor_imports"
    / "skills"
    / "skills"
    / ".curated"
    / "hatch-pet"
    / "scripts",
)


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-{2,}", "-", value)
    return value.strip("-")


def display_from_slug(value: str) -> str:
    return " ".join(part.capitalize() for part in value.split("-") if part)


def run(command: list[str], *, log_path: Path | None = None, stdin: str | None = None) -> None:
    command_line = "+ " + " ".join(command)
    print(command_line, flush=True)
    log_file = None
    if log_path:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = log_path.open("a", encoding="utf-8")
        print(command_line, file=log_file, flush=True)
    env = os.environ.copy()
    if command and Path(command[0]).name == "codex":
        command_dir = str(Path(command[0]).expanduser().absolute().parent)
        env["PATH"] = command_dir + os.pathsep + env.get("PATH", "")
    try:
        process = subprocess.Popen(
            command,
            cwd=REPO_ROOT,
            env=env,
            stdin=subprocess.PIPE if stdin is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        if stdin is not None and process.stdin:
            process.stdin.write(stdin)
            process.stdin.close()
        assert process.stdout is not None
        for line in process.stdout:
            print(line, end="", flush=True)
            if log_file:
                print(line, end="", file=log_file, flush=True)
        exit_code = process.wait()
        if exit_code:
            raise subprocess.CalledProcessError(exit_code, command)
    finally:
        if log_file:
            log_file.close()


def capture(command: list[str]) -> str:
    process = subprocess.run(command, cwd=REPO_ROOT, text=True, capture_output=True, check=True)
    return process.stdout.strip()


def ensure_hatch_scripts() -> None:
    global HATCH_SCRIPTS
    for candidate in HATCH_SCRIPT_CANDIDATES:
        if all(
            (candidate / name).is_file()
            for name in (
                "prepare_pet_run.py",
                "finalize_pet_run.py",
                "record_imagegen_result.py",
                "install_idle_preview_pet.py",
            )
        ):
            HATCH_SCRIPTS = candidate
            return
    missing = [
        name
        for name in (
            "prepare_pet_run.py",
            "finalize_pet_run.py",
            "record_imagegen_result.py",
            "install_idle_preview_pet.py",
        )
        if not any((candidate / name).is_file() for candidate in HATCH_SCRIPT_CANDIDATES)
    ]
    searched = ", ".join(str(path) for path in HATCH_SCRIPT_CANDIDATES)
    raise SystemExit(f"Pet generation scripts missing: {', '.join(missing)}. Searched: {searched}")


def ensure_codex_cli() -> str:
    codex = shutil.which("codex")
    if codex:
        return codex
    candidates = [
        Path("/opt/homebrew/bin/codex"),
        Path("/usr/local/bin/codex"),
    ]
    candidates.extend(
        sorted(
            Path("~/.nvm/versions/node").expanduser().glob("*/bin/codex"),
            reverse=True,
        )
    )
    for candidate in candidates:
        if Path(candidate).is_file():
            return str(candidate)
    raise SystemExit("codex CLI was not found; install or log in to Codex CLI first")


def remote_codex_host(args: argparse.Namespace) -> str:
    return (args.remote_host or os.environ.get("MIA_PET_REMOTE_HOST") or "").strip()


def remote_path_arg(value: str) -> str:
    if not value or not re.match(r"^[A-Za-z0-9_./:@~-]+$", value):
        raise SystemExit(f"unsafe remote path: {value!r}")
    return value


def remote_join(*parts: str) -> str:
    cleaned = [part.strip("/") for part in parts if part]
    if not cleaned:
        return ""
    first = cleaned[0]
    if parts[0].startswith("/"):
        return "/" + "/".join(cleaned)
    return "/".join(cleaned)


def remote_shell(args: list[str]) -> str:
    return " ".join(shlex.quote(str(arg)) for arg in args)


def sync_remote_reference(host: str, source: str, remote_refs: str, index: int) -> str:
    local = Path(source).expanduser().resolve()
    if not local.is_file():
        raise SystemExit(f"reference image not found: {source}")
    ext = local.suffix or ".png"
    remote_path = remote_path_arg(remote_join(remote_refs, f"reference-{index:02d}{ext}"))
    run(["rsync", "-a", str(local), f"{host}:{remote_path}"])
    return remote_path


def run_remote_codex_generation(
    *,
    args: argparse.Namespace,
    pet_id: str,
    display_name: str,
    description: str,
    run_dir: Path,
    package_dir: Path,
) -> int:
    host = remote_codex_host(args)
    if not host:
        return 1
    remote_home = capture(["ssh", host, 'printf "%s" "$HOME"'])
    if not remote_home.startswith("/"):
        raise SystemExit(f"could not determine remote home for {host}")
    root_arg = (args.remote_root or os.environ.get("MIA_PET_REMOTE_ROOT") or "").strip()
    remote_root_base = root_arg.replace("~", remote_home, 1) if root_arg.startswith("~") else root_arg
    if not remote_root_base:
        remote_root_base = f"{remote_home}/.mia/pet-runs"
    remote_root_base = remote_path_arg(remote_root_base)
    token = hashlib.sha1(str(run_dir).encode("utf-8")).hexdigest()[:10]
    remote_job = remote_path_arg(remote_join(remote_root_base, f"{pet_id}-{token}"))
    remote_generator = remote_path_arg(remote_join(remote_job, "pet-generator"))
    remote_run = remote_path_arg(remote_join(remote_job, "run"))
    remote_package = remote_path_arg(remote_join(remote_job, "package"))
    remote_refs = remote_path_arg(remote_join(remote_job, "references"))

    run(["ssh", host, f"mkdir -p {remote_shell([remote_generator, remote_run, remote_package, remote_refs])}"])
    run([
        "rsync",
        "-a",
        "--delete",
        "--exclude",
        "__pycache__",
        "--exclude",
        ".git",
        f"{GENERATOR_ROOT}/",
        f"{host}:{remote_generator}/",
    ])

    remote_references = [
        sync_remote_reference(host, reference, remote_refs, index)
        for index, reference in enumerate(args.reference or [], start=1)
    ]
    remote_style_references = [
        sync_remote_reference(host, reference, remote_refs, index + 100)
        for index, reference in enumerate(args.style_reference or [], start=1)
    ]

    remote_args = [
        "python3",
        "hatch_generate.py",
        "--prompt",
        args.prompt,
        "--pet-id",
        pet_id,
        "--display-name",
        display_name,
        "--description",
        description,
        "--style-notes",
        args.style_notes,
        "--style-contract",
        args.style_contract,
        "--row-concurrency",
        str(args.row_concurrency),
        "--run-dir",
        remote_run,
        "--package-dir",
        remote_package,
    ]
    if args.allow_slot_extraction:
        remote_args.append("--allow-slot-extraction")
    if args.no_partial_preview:
        remote_args.append("--no-partial-preview")
    if args.legacy_codex_handoff:
        remote_args.append("--legacy-codex-handoff")
    if args.no_run_codex:
        remote_args.append("--no-run-codex")
    for reference in remote_references:
        remote_args.extend(["--reference", reference])
    for reference in remote_style_references:
        remote_args.extend(["--style-reference", reference])

    remote_command = (
        f"cd {shlex.quote(remote_generator)} && "
        f"MIA_PET_REMOTE_ACTIVE=1 {remote_shell(remote_args)}"
    )
    try:
        run(["ssh", host, remote_command])
    finally:
        run_dir.mkdir(parents=True, exist_ok=True)
        package_dir.mkdir(parents=True, exist_ok=True)
        try:
            run(["rsync", "-a", f"{host}:{remote_run}/", f"{run_dir}/"])
            run(["rsync", "-a", f"{host}:{remote_package}/", f"{package_dir}/"])
        except subprocess.CalledProcessError as exc:
            print(f"warning: failed to sync remote pet outputs: {exc}", flush=True)

    summary = {
        "ok": True,
        "pet_id": pet_id,
        "display_name": display_name,
        "run_dir": str(run_dir),
        "package_dir": str(package_dir),
        "remote_host": host,
        "remote_run_dir": remote_run,
        "contact_sheet": str(run_dir / "qa" / "contact-sheet.png"),
        "log": str(run_dir / "generation.log"),
    }
    print(json.dumps(summary, indent=2), flush=True)
    return 0


def quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def codex_command(codex: str) -> list[str]:
    return [
        codex,
        "exec",
        "--cd",
        str(REPO_ROOT),
        "--sandbox",
        "danger-full-access",
        "-c",
        'approval_policy="never"',
        "-",
    ]


def load_imagegen_manifest(run_dir: Path) -> dict[str, object]:
    return json.loads((run_dir / "imagegen-jobs.json").read_text(encoding="utf-8"))


def imagegen_jobs(run_dir: Path) -> list[dict[str, object]]:
    jobs = load_imagegen_manifest(run_dir).get("jobs")
    if not isinstance(jobs, list):
        raise SystemExit("invalid imagegen-jobs.json: jobs must be a list")
    return [job for job in jobs if isinstance(job, dict)]


def completed_job_ids(run_dir: Path) -> set[str]:
    return {
        str(job["id"])
        for job in imagegen_jobs(run_dir)
        if job.get("status") == "complete" and isinstance(job.get("id"), str)
    }


def require_complete(run_dir: Path, job_ids: list[str]) -> None:
    completed = completed_job_ids(run_dir)
    missing = [job_id for job_id in job_ids if job_id not in completed]
    if missing:
        raise SystemExit(f"generation did not complete required job(s): {', '.join(missing)}")


def remaining_row_jobs(run_dir: Path) -> list[str]:
    completed = completed_job_ids(run_dir)
    result = []
    for job in imagegen_jobs(run_dir):
        job_id = job.get("id")
        if not isinstance(job_id, str) or job_id in {"base", "idle"}:
            continue
        if job.get("kind") == "row-strip" and job_id not in completed:
            result.append(job_id)
    return result


def write_base_idle_prompt(
    *,
    path: Path,
    pet_id: str,
    display_name: str,
    description: str,
    user_prompt: str,
    style_notes: str,
    run_dir: Path,
    package_dir: Path,
    install_preview: bool,
) -> None:
    preview_step = (
        f"""
4. After `idle` is recorded, immediately install a temporary playable package with:
   python3 {HATCH_SCRIPTS / "install_idle_preview_pet.py"} --run-dir {run_dir} --petctl {PETCTL} --pet-id {quote(pet_id)} --display-name {quote(display_name)} --description {quote(description)} --force
   This preview intentionally reuses idle frames for every state so the pet can be placed on desktop while remaining rows are still generating.
5. Stop after base + idle + preview install. Do not generate other rows, do not finalize the complete pet.
"""
        if install_preview
        else """
4. Stop after base + idle. Do not generate other rows, do not finalize the complete pet.
"""
    )
    prompt = f"""You are running inside Codex CLI for Alkaka's native desktop pet creator.

Goal: create the minimum playable preview for one Mia desktop pet.

User sentence:
{user_prompt}

Style notes:
{style_notes or "(none)"}

Pet metadata:
- pet_id: {pet_id}
- display_name: {display_name}
- description: {description}
- run_dir: {run_dir}
- install_dir: {package_dir}

Rules:
- Do not ask for or use OPENAI_API_KEY.
- Use Codex's built-in image generation through the installed imagegen skill.
- Use the Hatch Pet deterministic scripts only for prepare/record/install work.
- Do not build or open a browser UI.
- Generate only `base` and `idle` in this stage.

Work:
1. Read the Alkaka Friend Pet skill and follow its visual generation rules: {HATCH_SCRIPTS.parent / "SKILL.md"}
2. Generate `base` from {run_dir / "prompts" / "base-pet.md"}, then record it with:
   python3 {HATCH_SCRIPTS / "record_imagegen_result.py"} --run-dir {run_dir} --job-id base --source <generated-output.png>
3. Generate `idle` from {run_dir / "prompts" / "rows" / "idle.md"} with its required input images from {run_dir / "imagegen-jobs.json"}, then record it with:
   python3 {HATCH_SCRIPTS / "record_imagegen_result.py"} --run-dir {run_dir} --job-id idle --source <generated-output.png>
{preview_step}
At the end, print compact JSON with ok, stage, pet_id, run_dir, and package_dir.
"""
    path.write_text(prompt, encoding="utf-8")


def write_row_worker_prompt(*, path: Path, job_id: str, run_dir: Path) -> None:
    prompt_file = run_dir / "prompts" / "rows" / f"{job_id}.md"
    prompt = f"""You are running inside Codex CLI as one row worker for Alkaka Hatch Pet.

Generate exactly one row-strip job: `{job_id}`.

Rules:
- Do not ask for or use OPENAI_API_KEY.
- Use Codex's built-in image generation through the installed imagegen skill.
- Read {run_dir / "imagegen-jobs.json"} and attach every input image listed for `{job_id}`.
- Use {prompt_file} as the authoritative visual spec.
- Do not generate, record, modify, repair, or finalize any other job.
- Do not install a pet package.

After choosing the generated image, record only this job with:
python3 {HATCH_SCRIPTS / "record_imagegen_result.py"} --run-dir {run_dir} --job-id {job_id} --source <generated-output.png>

At the end, print compact JSON with ok, job_id, and selected source path.
"""
    path.write_text(prompt, encoding="utf-8")


def write_handoff_prompt(
    *,
    path: Path,
    pet_id: str,
    display_name: str,
    description: str,
    user_prompt: str,
    style_notes: str,
    allow_slot_extraction: bool,
    run_dir: Path,
    package_dir: Path,
) -> None:
    finalize_flags = "--skip-videos --skip-package"
    if allow_slot_extraction:
        finalize_flags += " --allow-slot-extraction"
    prompt = f"""You are running inside Codex CLI for Alkaka's native desktop pet creator.

Goal: turn one user sentence into a usable Alkaka partner/friend desktop pet package.

User sentence:
{user_prompt}

Style notes:
{style_notes or "(none)"}

Pet metadata:
- pet_id: {pet_id}
- display_name: {display_name}
- description: {description}
- run_dir: {run_dir}
- install_dir: {package_dir}

Hard requirements:
- Do not ask for or use OPENAI_API_KEY.
- Do not call the Image API directly.
- Use Codex's built-in image generation tool through the installed imagegen skill.
- Use the Hatch Pet deterministic scripts only for prepare/record/finalize/package work.
- This is launched from a native Qt app. Do not build or open a browser UI.
- The user explicitly approves sequential row generation for this one-shot app flow if subagents are unavailable.

Skill and scripts:
- Alkaka Friend Pet skill: {HATCH_SCRIPTS.parent / "SKILL.md"}
- Scripts directory: {HATCH_SCRIPTS}
- Alkaka installer: {PETCTL}

Run that already exists:
- {run_dir}

Work to complete:
1. Read the Alkaka Friend Pet skill and follow its visual generation rules.
2. Inspect {run_dir / "imagegen-jobs.json"} and generate the base pet plus all required animation rows using built-in image generation.
3. For every selected generated image, record it with:
   python3 {HATCH_SCRIPTS / "record_imagegen_result.py"} --run-dir {run_dir} --job-id <job-id> --source <generated-output.png>
4. Finalize with:
   python3 {HATCH_SCRIPTS / "finalize_pet_run.py"} --run-dir {run_dir} {finalize_flags}
5. Install for Alkaka with:
   python3 {PETCTL} install {run_dir / "final" / "spritesheet.png"} --id {quote(pet_id)} --name {quote(display_name)} --description {quote(description)} --force
6. Verify the installed package has pet.json and spritesheet.png under {package_dir}.

At the end, print a compact JSON object with ok, pet_id, run_dir, package_dir, and contact_sheet.
"""
    path.write_text(prompt, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--pet-id", default="")
    parser.add_argument("--display-name", default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--style-notes", default="")
    parser.add_argument("--style-contract", default="")
    parser.add_argument("--reference", action="append", default=[])
    parser.add_argument("--style-reference", action="append", default=[])
    parser.add_argument("--run-dir", default="")
    parser.add_argument("--package-dir", default="")
    parser.add_argument("--allow-slot-extraction", action="store_true", default=True)
    parser.add_argument("--row-concurrency", type=int, default=3)
    parser.add_argument("--no-partial-preview", action="store_true")
    parser.add_argument("--legacy-codex-handoff", action="store_true")
    parser.add_argument("--no-run-codex", action="store_true")
    parser.add_argument("--remote-host", default="")
    parser.add_argument("--remote-root", default="")
    args = parser.parse_args()

    ensure_hatch_scripts()

    pet_id = slugify(args.pet_id or args.display_name or args.prompt.split(",", 1)[0])
    if not pet_id:
        pet_id = "custom-pet"
    display_name = args.display_name or display_from_slug(pet_id)
    description = args.description or f"{display_name}: {args.prompt.strip()}."
    run_dir = (
        Path(args.run_dir).expanduser().resolve()
        if args.run_dir
        else (REPO_ROOT / "output" / "hatch-pet" / pet_id).resolve()
    )
    package_dir = (
        Path(args.package_dir).expanduser().resolve()
        if args.package_dir
        else Path("~/.mia/pets").expanduser().resolve() / pet_id
    )
    log_path = run_dir / "generation.log"
    if log_path.exists():
        log_path.unlink()

    if remote_codex_host(args) and not os.environ.get("MIA_PET_REMOTE_ACTIVE"):
        return run_remote_codex_generation(
            args=args,
            pet_id=pet_id,
            display_name=display_name,
            description=description,
            run_dir=run_dir,
            package_dir=package_dir,
        )

    codex = ensure_codex_cli()

    prepare = [
        sys.executable,
        str(HATCH_SCRIPTS / "prepare_pet_run.py"),
        "--pet-id",
        pet_id,
        "--pet-name",
        display_name,
        "--display-name",
        display_name,
        "--description",
        description,
        "--pet-notes",
        args.prompt,
        "--output-dir",
        str(run_dir),
        "--force",
    ]
    if args.style_notes:
        prepare.extend(["--style-notes", args.style_notes])
    if args.style_contract:
        prepare.extend(["--style-contract", args.style_contract])
    for reference in args.style_reference:
        prepare.extend(["--style-reference", reference])
    for reference in args.reference:
        prepare.extend(["--reference", reference])
    run(prepare, log_path=log_path)

    handoff_prompt = run_dir / "codex-handoff-prompt.md"
    write_handoff_prompt(
        path=handoff_prompt,
        pet_id=pet_id,
        display_name=display_name,
        description=description,
        user_prompt=args.prompt.strip(),
        style_notes=args.style_notes,
        allow_slot_extraction=args.allow_slot_extraction,
        run_dir=run_dir,
        package_dir=package_dir,
    )

    if args.no_run_codex:
        print(f"Prepared Codex handoff prompt: {handoff_prompt}", flush=True)
    elif args.legacy_codex_handoff:
        run(codex_command(codex), log_path=log_path, stdin=handoff_prompt.read_text(encoding="utf-8"))
    else:
        base_idle_prompt = run_dir / "codex-base-idle-prompt.md"
        write_base_idle_prompt(
            path=base_idle_prompt,
            pet_id=pet_id,
            display_name=display_name,
            description=description,
            user_prompt=args.prompt.strip(),
            style_notes=args.style_notes,
            run_dir=run_dir,
            package_dir=package_dir,
            install_preview=not args.no_partial_preview,
        )
        run(
            codex_command(codex),
            log_path=log_path,
            stdin=base_idle_prompt.read_text(encoding="utf-8"),
        )
        require_complete(run_dir, ["base", "idle"])

        row_jobs = remaining_row_jobs(run_dir)
        if row_jobs:
            max_workers = max(1, min(args.row_concurrency, len(row_jobs)))
            print(
                f"Generating remaining row jobs with concurrency={max_workers}: {', '.join(row_jobs)}",
                flush=True,
            )

            def run_row(job_id: str) -> str:
                prompt_path = run_dir / f"codex-row-{job_id}-prompt.md"
                write_row_worker_prompt(path=prompt_path, job_id=job_id, run_dir=run_dir)
                run(
                    codex_command(codex),
                    log_path=run_dir / f"generation-{job_id}.log",
                    stdin=prompt_path.read_text(encoding="utf-8"),
                )
                require_complete(run_dir, [job_id])
                return job_id

            with ThreadPoolExecutor(max_workers=max_workers) as executor:
                futures = {executor.submit(run_row, job_id): job_id for job_id in row_jobs}
                for future in as_completed(futures):
                    job_id = futures[future]
                    try:
                        completed = future.result()
                        print(f"Completed row job: {completed}", flush=True)
                    except Exception as exc:  # noqa: BLE001
                        raise SystemExit(f"row job {job_id} failed: {exc}") from exc

        run(
            [
                sys.executable,
                str(HATCH_SCRIPTS / "finalize_pet_run.py"),
                "--run-dir",
                str(run_dir),
                "--skip-videos",
                "--skip-package",
                "--allow-slot-extraction",
            ],
            log_path=log_path,
        )
        run(
            [
                sys.executable,
                str(HATCH_SCRIPTS / "package_custom_pet.py"),
                "--pet-name",
                pet_id,
                "--display-name",
                display_name,
                "--description",
                description,
                "--spritesheet",
                str(run_dir / "final" / "spritesheet.webp"),
                "--output-dir",
                str(package_dir),
                "--force",
            ],
            log_path=log_path,
        )

    summary = {
        "ok": True,
        "pet_id": pet_id,
        "display_name": display_name,
        "run_dir": str(run_dir),
        "package_dir": str(package_dir),
        "contact_sheet": str(run_dir / "qa" / "contact-sheet.png"),
        "handoff_prompt": str(handoff_prompt),
        "log": str(log_path),
    }
    print(json.dumps(summary, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
