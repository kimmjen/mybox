#!/usr/bin/env python3
"""
compile.py 테스트 스크립트
- 더미 PNG 생성 → compile.py 호출 → PDF 파일명 확인
"""

import os
import sys
import subprocess
import tempfile
import shutil

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow not installed. Run: pip install Pillow")
    sys.exit(1)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
COMPILE_PY = os.path.join(SCRIPT_DIR, "compile.py")


def make_dummy_pages(screenshots_dir, count=3):
    os.makedirs(screenshots_dir, exist_ok=True)
    for i in range(1, count + 1):
        img = Image.new("RGB", (800, 1100), color=(30 + i * 20, 50, 80))
        img.save(os.path.join(screenshots_dir, f"page_{i:04d}.png"))


def run_test(label, custom_filename, expected_pdf_name):
    tmpdir = tempfile.mkdtemp(prefix="mybox_test_")
    try:
        screenshots_dir = os.path.join(tmpdir, "naver_mybox_temp_screenshots")
        make_dummy_pages(screenshots_dir)

        cmd = [sys.executable, COMPILE_PY, tmpdir]
        if custom_filename is not None:
            cmd.append(custom_filename)

        result = subprocess.run(cmd, capture_output=True, text=True)
        output = result.stdout + result.stderr

        expected_path = os.path.join(tmpdir, expected_pdf_name)
        ok = os.path.isfile(expected_path) and result.returncode == 0

        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {label}")
        if not ok:
            print(f"       expected: {expected_pdf_name}")
            print(f"       output dir: {os.listdir(tmpdir)}")
            print(f"       stdout: {output.strip()}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    print("=== compile.py 파일명 테스트 ===\n")
    run_test("커스텀 파일명 'TEST'",        "TEST",              "TEST.pdf")
    run_test("커스텀 파일명 '내 문서'",      "내 문서",            "내 문서.pdf")
    run_test("자동 제목 (argv 없음)",        None,               "mybox_document.pdf")
    run_test("빈 문자열 → fallback",        "",                 "mybox_document.pdf")
    run_test("특수문자 포함 → sanitize",    "TEST<>:/\\|?*",    "TEST.pdf")
    print("\n완료.")
