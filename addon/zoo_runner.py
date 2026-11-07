import argparse
import inspect
import json
import os
import sys
import threading
import warnings

warnings.filterwarnings("ignore")

PROTOCOL = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr


def emit(**message):
    PROTOCOL.write(json.dumps(message) + "\n")
    PROTOCOL.flush()


def exit_with_parent():
    sys.stdin.read()
    os._exit(1)


def load_model(bmz, name, threads):
    if name == "HawkEars_Low_Band":
        from bioacoustics_model_zoo.bmz_hawkears import hawkears_base_config as config
        if not hasattr(config.Audio, "low_band_mel_scale"):
            config.Audio.low_band_mel_scale = config.Audio.low_band_scale == "mel"
    if name == "Perch2ONNX":
        return bmz.Perch2ONNX(no_dft=True)
    return getattr(bmz, name)()


def predict_options(model, batch_size):
    parameters = inspect.signature(model.predict).parameters
    open_ended = any(p.kind == p.VAR_KEYWORD for p in parameters.values())
    options = {name: value for name, value in (("batch_size", batch_size), ("num_workers", 0)) if name in parameters or open_ended}
    if "progress_bar" in parameters:
        options["progress_bar"] = False
    return options


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--files", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--threads", type=int, default=1)
    parser.add_argument("--batch-size", type=int, default=4)
    args = parser.parse_args()

    threading.Thread(target=exit_with_parent, daemon=True).start()

    import torch
    torch.set_num_threads(max(1, args.threads))
    import bioacoustics_model_zoo as bmz
    if os.environ.get("CROW_MODEL_CACHE"):
        bmz.set_default_cache_dir(os.environ["CROW_MODEL_CACHE"])

    import numpy as np

    with open(args.files, encoding="utf-8") as f:
        files = json.load(f)

    emit(type="status", stage="loading")
    model = load_model(bmz, args.model, args.threads)
    from importlib.metadata import version
    versions = {name: version(name) for name in ("bioacoustics-model-zoo", "opensoundscape", "torch")}
    if getattr(model, "version", None) is not None:
        versions["model"] = str(model.version)
    preprocessor = getattr(model, "preprocessor", None)
    clip_s = float(preprocessor.sample_duration) if preprocessor is not None else None
    emit(type="model", classes=[str(c) for c in model.classes], clip_s=clip_s, versions=versions)
    options = predict_options(model, args.batch_size)
    reported = False

    for index, path in enumerate(files):
        try:
            predictions = model.predict([path], **options)
            starts = predictions.index.get_level_values("start_time").to_numpy(dtype="float64")
            if not reported and len(predictions):
                ends = predictions.index.get_level_values("end_time").to_numpy(dtype="float64")
                emit(type="segments", clip_s=float(ends[0] - starts[0]), interval_s=float(starts[1] - starts[0]) if len(starts) > 1 else None)
                reported = True
            out = os.path.join(args.out, f"{index}.npz")
            np.savez(out, starts=starts, scores=predictions.to_numpy(dtype="float32"))
            emit(type="file", index=index, npz=out)
        except Exception as error:
            emit(type="file_error", index=index, error=f"{type(error).__name__}: {error}")

    emit(type="finished")


if __name__ == "__main__":
    main()
