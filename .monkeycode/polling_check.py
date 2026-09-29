#!/usr/bin/env python3
"""定时巡检脚本 - 每14分钟检查一次上传状态，有新上传时自动运行盘点工具"""
import time
import json
import subprocess
import sys
import os
import requests
from datetime import datetime

CHECK_URL = 'https://q.qjwykj.com/public/index.php/upload-check'
CHECK_TOKEN = 'wqy-pandian-monitor-2026'
PANDIAN_SCRIPT = '/workspace/.monkeycode/盘点工具.py'
LOG_FILE = '/tmp/polling_check.log'
LOCK_FILE = '/tmp/polling_check.lock'

def log(msg):
    ts = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    line = f'[{ts}] {msg}'
    print(line)
    with open(LOG_FILE, 'a') as f:
        f.write(line + '\n')

def check_upload():
    try:
        resp = requests.get(CHECK_URL, params={'token': CHECK_TOKEN}, timeout=15)
        data = resp.json()
        return data
    except Exception as e:
        log(f'检查上传状态失败: {e}')
        return None

def run_pandian():
    log('检测到新上传，启动盘点工具...')
    try:
        # 使用独立终端运行，避免阻塞
        cmd = ['timeout', '600', 'xvfb-run', '-a', sys.executable, PANDIAN_SCRIPT]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=620)
        log(f'盘点工具执行完成，返回码: {result.returncode}')
        if result.stdout:
            log(f'输出: {result.stdout[:500]}')
        if result.stderr:
            log(f'错误: {result.stderr[:500]}')
        return result.returncode == 0
    except subprocess.TimeoutExpired:
        log('盘点工具执行超时')
        return False
    except Exception as e:
        log(f'启动盘点工具失败: {e}')
        return False

def main():
    log('=' * 50)
    log('巡检任务已启动')
    log(f'检查间隔: 14分钟')
    log('=' * 50)
    
    interval = 14 * 60  # 14分钟
    
    while True:
        try:
            data = check_upload()
            if data:
                last_14m = data.get('last_14m', False)
                pandian_user = data.get('pandian_user', {})
                name = pandian_user.get('name', '未知')
                user_id = pandian_user.get('userid', '')
                
                log(f'检查时间: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}')
                log(f'上传状态: {"有新上传" if last_14m else "无新上传"}')
                log(f'盘点员: {name} (userid={user_id})')
                
                if last_14m:
                    run_pandian()
                else:
                    log('跳过盘点')
            else:
                log('无法获取上传状态，等待重试...')
        except Exception as e:
            log(f'巡检循环异常: {e}')
        
        log(f'下次检查: {datetime.now().strftime("%Y-%m-%d %H:%M:%S")} (+14分钟)')
        time.sleep(interval)

if __name__ == '__main__':
    main()
