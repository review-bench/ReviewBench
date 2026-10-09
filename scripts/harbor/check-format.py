"""Check an export against Harbor's installed schemas and actual task packager."""

import argparse
import hashlib
from pathlib import Path

from harbor.models.dataset.manifest import DatasetManifest
from harbor.models.task.config import TaskConfig
from harbor.publisher.packager import Packager


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    dataset = DatasetManifest.from_toml_file(args.directory / "dataset.toml")
    if not dataset.tasks:
        raise ValueError("Dataset contains no tasks")
    for reference in dataset.tasks:
        directory = args.directory / reference.short_name
        task = TaskConfig.model_validate_toml((directory / "task.toml").read_text(encoding="utf-8"))
        if task.task.name != reference.name:
            raise ValueError(f"Wrong task name: {reference.name}")
        digest, _ = Packager.compute_content_hash(directory)
        if reference.digest != f"sha256:{digest}":
            raise ValueError(f"Wrong task digest: {reference.name}")
    for reference in dataset.files:
        digest = hashlib.sha256((args.directory / reference.path).read_bytes()).hexdigest()
        if reference.digest != f"sha256:{digest}":
            raise ValueError(f"Wrong dataset file digest: {reference.path}")
    print(f"Harbor schemas and content digests validated for {len(dataset.tasks)} tasks")


if __name__ == "__main__":
    main()
