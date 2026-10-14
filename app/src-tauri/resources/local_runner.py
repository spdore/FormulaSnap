"""Small persistent worker around the upstream RapidLaTeXOCR ONNX implementation."""
import argparse
import base64
import json
import sys
from pathlib import Path


def get_runtime():
    import onnxruntime as ort
    return ort


def report_providers():
    try:
        providers = get_runtime().get_available_providers()
        print(json.dumps({"providers": providers}), flush=True)
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)[:900]}), flush=True)
        return 1


class FormulaOrtSession:
    requested = "CPUExecutionProvider"
    actual = None
    ort = None

    def __init__(self, model_path, num_threads=-1):
        import onnxruntime as ort
        self.ort = ort
        options = ort.SessionOptions()
        options.log_severity_level = 4
        options.enable_cpu_mem_arena = False
        if num_threads > 0:
            options.intra_op_num_threads = num_threads
        if self.requested == "CUDAExecutionProvider":
            preload = getattr(ort, "preload_dlls", None)
            if preload is None:
                raise RuntimeError("当前 ONNX Runtime 缺少 CUDA DLL 预加载支持。")
            preload(directory="")
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        providers = [self.requested]
        if self.requested != "CPUExecutionProvider":
            providers.append("CPUExecutionProvider")
        available = ort.get_available_providers()
        if self.requested not in available:
            raise RuntimeError(f"所选推理后端不可用：{self.requested}；当前可用：{', '.join(available)}")
        self.session = ort.InferenceSession(str(model_path), sess_options=options, providers=providers)
        active = self.session.get_providers()
        if not active or active[0] != self.requested:
            raise RuntimeError(f"运行时没有启用所选 GPU 后端 {self.requested}，实际后端：{active}")
        FormulaOrtSession.actual = active[0]

    def __call__(self, inputs):
        try:
            input_names = [item.name for item in self.session.get_inputs()]
            return self.session.run(None, dict(zip(input_names, inputs)))
        except Exception as exc:
            raise RuntimeError(f"ONNX 推理失败：{exc}") from exc

    def get_input_names(self):
        return [item.name for item in self.session.get_inputs()]

    def get_output_name(self, output_idx=0):
        return self.session.get_outputs()[output_idx].name

    def get_metadata(self):
        return self.session.get_modelmeta().custom_metadata_map


def start_worker(model_dir: Path, requested_device: str):
    import rapid_latex_ocr.main as main_module
    import rapid_latex_ocr.models as model_module
    import rapid_latex_ocr.utils_load as load_module

    provider_by_device = {
        "cpu": "CPUExecutionProvider",
        "cuda": "CUDAExecutionProvider",
    }
    if requested_device not in provider_by_device:
        raise RuntimeError("未知的推理设备选项。")
    FormulaOrtSession.requested = provider_by_device[requested_device]
    FormulaOrtSession.actual = None
    main_module.OrtInferSession = FormulaOrtSession
    model_module.OrtInferSession = FormulaOrtSession
    load_module.OrtInferSession = FormulaOrtSession

    required = ["image_resizer.onnx", "encoder.onnx", "decoder.onnx", "tokenizer.json"]
    paths = [model_dir / filename for filename in required]
    missing = [str(path) for path in paths if not path.is_file() or path.stat().st_size < 8]
    if missing:
        raise RuntimeError("模型文件缺失或损坏：" + ", ".join(missing))

    engine = main_module.LaTeXOCR(
        image_resizer_path=str(paths[0]),
        encoder_path=str(paths[1]),
        decoder_path=str(paths[2]),
        tokenizer_json=str(paths[3]),
    )
    if FormulaOrtSession.actual != FormulaOrtSession.requested:
        raise RuntimeError("运行时后端未能与所选设备匹配。")
    print(json.dumps({"ready": True, "backend": FormulaOrtSession.actual}), flush=True)

    for line in sys.stdin:
        try:
            message = json.loads(line)
            image_bytes = base64.b64decode(message["imageBase64"], validate=True)
            if not image_bytes or len(image_bytes) > 32 * 1024 * 1024:
                raise ValueError("图片为空或大于 32 MiB。")
            formula, seconds = engine(image_bytes)
            print(json.dumps({"latex": formula, "elapsedMs": round(seconds * 1000), "backend": FormulaOrtSession.actual}, ensure_ascii=False), flush=True)
        except Exception as exc:
            print(json.dumps({"error": str(exc)[:1500]}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--providers", action="store_true")
    parser.add_argument("--serve", action="store_true")
    parser.add_argument("--model-dir")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()
    if args.providers:
        return report_providers()
    if args.serve:
        try:
            start_worker(Path(args.model_dir).resolve(), args.device)
            return 0
        except Exception as exc:
            print(json.dumps({"error": str(exc)[:1500]}, ensure_ascii=False), flush=True)
            return 1
    parser.error("specify --providers or --serve")


if __name__ == "__main__":
    raise SystemExit(main())
