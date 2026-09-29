from selenium import webdriver
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from urllib.parse import urlunparse
from urllib.parse import urlparse as parsed_url_parse
from datetime import datetime
import os
from selenium.common.exceptions import NoSuchElementException



import time
import pandas as pd
from selenium.webdriver.support.ui import Select
from urllib.parse import urlparse, urlunparse, parse_qs, urlencode
import requests
import json
import re
import subprocess
import sys

# ============== 防超时强杀：把自己放到独立会话里执行 ==============
# 巡检命令外层是 `timeout 600 xvfb-run -a python3 盘点工具.py`。
# 到 600 秒时 timeout 会给 xvfb-run（及其进程组）发 TERM，xvfb-run 退出清理时
# 会连带杀掉 Xvfb，浏览器自动化随即断开，盘点永远盘不完。
# 做法：脚本首次启动时，用独立会话（setsid，即 start_new_session=True）+ 自己的
# xvfb-run 把真正的执行体重新拉起，父进程立刻返回。
# 这样 600 秒的 TERM 既打不到执行体，也打不到它自己的 Xvfb。
# 再用文件锁保证同一时间只有一个盘点进程，避免重复盘点。
_DETACHED_ENV = 'PANDIAN_DETACHED'
_LOCK_PATH = '/tmp/pandian_tool.lock'
_LOG_PATH = None
_lock_fd = None


def _acquire_single_lock():
    """尝试独占文件锁，成功返回 fd，失败返回 None"""
    import fcntl
    fd = os.open(_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd


def _spawn_detached():
    """把自身以独立会话 + 独立 xvfb-run 重新拉起"""
    self_path = os.path.realpath(__file__)
    env = dict(os.environ)
    env[_DETACHED_ENV] = '1'
    env.pop('DISPLAY', None)
    env.pop('XAUTHORITY', None)
    subprocess.Popen(
        ['xvfb-run', '-a', sys.executable, '-u', self_path],
        cwd=os.path.dirname(self_path),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=None,
        stderr=None,
        start_new_session=True,  # 等价于 setsid，脱离 timeout 的进程组/会话
    )


if os.environ.get(_DETACHED_ENV) != '1':
    _probe_fd = _acquire_single_lock()
    if _probe_fd is None:
        print('已有盘点进程在运行，本次跳过')
        sys.exit(0)
    os.close(_probe_fd)  # 释放，交由子进程持有
    try:
        _spawn_detached()
    except Exception as _e:
        print(f'后台脱离启动失败，改为前台运行: {_e}')
    else:
        print(f'盘点已在独立会话后台启动（不受 timeout 600 影响），日志: {_LOG_PATH}')
        sys.exit(0)
else:
    _lock_fd = _acquire_single_lock()
    if _lock_fd is None:
        print('已有盘点进程在运行，本次跳过')
        sys.exit(0)

# ============== 用户选择 ==============
# 优先从 q.qjwykj.com 检测接口读取最新上传的盘点员（上传页面选择的）
# 读不到时退回手动输入
CHECK_URL = 'https://q.qjwykj.com/public/index.php/upload-check'
CHECK_TOKEN = 'wqy-pandian-monitor-2026'

def fetch_pandian_user():
    """从服务器接口获取最新上传的盘点员信息，失败返回 None"""
    try:
        resp = requests.get(CHECK_URL, params={'token': CHECK_TOKEN}, timeout=10)
        data = resp.json()
        user = data.get('pandian_user') or {}
        userid = user.get('userid')
        name = user.get('name')
        if userid and name:
            batch = data.get('latest_batch') or {}
            return {
                'userid': userid,
                'name': name,
                'batch_time': batch.get('updated_at', ''),
            }
    except Exception as e:
        print(f'获取服务器盘点员信息失败: {e}')
    return None

print('=' * 40)
print('      盘点工具 - 用户选择')
print('=' * 40)

# 1. 尝试从服务器读取（上传页面选过的盘点员）
server_user = fetch_pandian_user()
if server_user:
    print(f'检测到最新上传: {server_user["name"]}')
    print(f'  批次时间: {server_user["batch_time"]}')
    print(f'  userid:   {server_user["userid"]}')
    print('=' * 40)
    selected_userid = server_user['userid']
    selected_name = server_user['name']
else:
    # 2. 服务器没记录，退回手动输入
    print('  服务器无最新上传记录，请手动选择:')
    print('=' * 40)
    print('  1. 沈平仙 (userid=84522)')
    print('  2. 刘姣   (userid=300000002722)')
    print('=' * 40)

    while True:
        choice = input('请输入编号 (1 或 2): ').strip()
        if choice == '1':
            selected_userid = '84522'
            selected_name = '沈平仙'
            break
        elif choice == '2':
            selected_userid = '300000002722'
            selected_name = '刘姣'
            break
        else:
            print('输入有误，请重新输入！')

print(f'已选择: {selected_name} (userid={selected_userid})')
print('=' * 40)
time.sleep(1)

# ============== 主程序 ==============
max_retries = 8  # 最大重试次数
retries = 0  # 当前重试次数
cutid = ""
zx_hjfq = ""
userid = ""
placepointname = ""

def run_pandian():
    """执行一次盘点流程"""
    firefox_options = FirefoxOptions()
    firefox_options.add_argument("--headless")
    firefox_options.add_argument("--width=460")
    firefox_options.add_argument("--height=860")
    driver = webdriver.Firefox(options=firefox_options)
    
    try:
        url = f"http://pandian.jzj.cn/pandian/MDH00103/OP100015/index?userid={selected_userid}"  
        driver.get(url)  
        time.sleep(2)

        # 检查已经建立的
        elements = driver.find_elements(By.XPATH, '//label[@class="demo_label"]/img[@class="clickimg"]')

        #如果等于0则是新打开的
        var=0
        if len(elements)==0:

            for i in range(3):
                try:
                    # 等待 doorFoot div 出现并点击 "新增" 按钮
                    doorfoot_div = WebDriverWait(driver, 10).until(
                        EC.presence_of_element_located((By.CSS_SELECTOR, 'div.doorFoot'))
                    )
                    inventory_li = doorfoot_div.find_element(By.CSS_SELECTOR, 'li[onclick="mdpd_1()"]')
                    inventory_li.click()  # 新增
                    print("'新建' 按钮点击成功！")
                    
                    # 找到下拉框元素
                    select_element = driver.find_element(By.ID, "zx_hjfq")
                    select = Select(select_element)
                    # 获取所有选项
                    options = select.options
                    select.select_by_index(i)
                    # 点击 "新建" 按钮
                    new_button = driver.find_element(By.XPATH, "//button[@onclick='buildInventory()']")
                    new_button.click()
                    
                except Exception as e:
                    print(f"点击'新增'按钮时发生错误: {e}")

            # 循环结束刷新页面
            driver.refresh()
            print('浏览器刷新')

        # 封装一个函数来隐藏具有特定CSS类的元素  
        def hide_elements_by_class(driver, css_class):  
            elements = driver.find_elements(By.CSS_SELECTOR, f'.{css_class}')  
            for element in elements:
                driver.execute_script("arguments[0].style.display = 'none';", element)  
        
        # 封装一个函数来设置元素的height和line-height样式  
        def set_element_styles(driver, css_class, height, line_height):  
            elements = driver.find_elements(By.CSS_SELECTOR, f'.{css_class}')  
            for element in elements:
                driver.execute_script(f"arguments[0].style.height = '{height}';", element)  
                driver.execute_script(f"arguments[0].style['line-height'] = '{line_height}';", element)  
        
        # 使用封装的函数来隐藏元素和设置样式  
        hide_elements_by_class(driver, 'doorboxNum')  
        hide_elements_by_class(driver, 'doorbox_r')  
        set_element_styles(driver, 'demo_label', '20px', '0')  

        elements = driver.find_elements(By.XPATH, "//img[@zx_hjfq]")  
        element_len = len(elements) 


        def requst(goodsid_value,cutid,zx_hjfq,userid,placepointname):
            try:  
                #url = f"http://115.191.21.67/public/index.php/jiekou?id={goodsid_value}&dp=世纪花城&openid=o2JZP5iZ8fzb-b6BPblMMrtBGc_I"  
                url = f"https://q.qjwykj.com/public/index.php/jiekou?id={goodsid_value}&dp=曲陆苑&openid=o2JZP5iZ8fzb-b6BPblMMrtBGc_I"  
                response = requests.get(url)  
                if response.status_code == 200:
                    try:
                        # 解析JSON数据
                        data = json.loads(response.text)
                        
                        # 初始化默认值
                        number_str = '0'  # 货品数量默认值
                        number_qrcode = ''  # 条形码默认值

                        # 检查 data 是否包含 'message' 键
                        if 'message' in data:
                            message_content = data['message']
                            
                            ##############################################
                            # 情况1：message是列表
                            ##############################################
                            if isinstance(message_content, list):
                                print("检测到message是列表结构，开始遍历...")
                                
                                # 单次遍历同时获取两个字段
                                for item in message_content:
                                    # 类型安全检查
                                    if not isinstance(item, dict):
                                        continue
                                    
                                    # 获取货品数量（仅首次有效）
                                    if number_str == '0' and '货品数量' in item:
                                        number_str = str(item['货品数量']).strip()  # 去除前后空格
                                        print(f"从列表项中获取到货品数量: {number_str}")
                                    
                                    # 获取条形码（仅首次有效）
                                    if not number_qrcode and '条形码' in item:
                                        number_qrcode = str(item['条形码']).strip()  # 去除前后空格
                                        print(f"从列表项中获取到条形码: {number_qrcode}")
                                    
                                    # 提前终止条件：两个字段都已找到
                                    if number_str != '0' and number_qrcode:
                                        break

                            ##############################################
                            # 情况2：message是字典
                            ##############################################
                            elif isinstance(message_content, dict):
                                print("检测到message是字典结构")
                                
                                # 货品数量提取
                                if '货品数量' in message_content:
                                    number_str = str(message_content['货品数量']).strip()  # 去除前后空格
                                    print(f"从字典中获取到货品数量: {number_str}")
                                
                                # 条形码提取
                                if '条形码' in message_content:
                                    number_qrcode = str(message_content['条形码']).strip()  # 去除前后空格
                                    print(f"从字典中获取到条形码: {number_qrcode}")

                            ##############################################
                            # 情况3：意外类型处理
                            ##############################################
                            else:
                                print(f"警告：message字段是意外类型 - {type(message_content)}")
                                
                        else:
                            print("响应数据中未找到message字段")


                        # 判断条形码是否满足异常情况
                        if not number_qrcode or number_qrcode.strip() == "数据库中没有该条码":
                            print("没有条码")  # 异常情况：条形码为空或为"数据库中没有该条码"
                            #进行手工输入
                            sg=f"http://pandian.jzj.cn/pandian/MDH00103/OP100015/showGoodsByGoodsId?placepointid=1028&zx_hjfq={zx_hjfq}&cutid={cutid}&type=index&placepointname={placepointname}&storageid=1025&entryid=10&userid={userid}&cuttypeid=null&goodsid={goodsid_value}&barcode={goodsid_value}"
                            # 使用Selenium打开修改后的URL  
                            driver.get(sg)  

                            current_url = driver.current_url  
                            parsed_url = urlparse(current_url)  
                            query_params = parse_qs(parsed_url.query)  
                        else:
                            print("有条码")  # 正常情况：条形码有效
                            #进行扫码输入
                            sm=f"http://pandian.jzj.cn/pandian/MDH00103/OP100015/getGoodsByBarcode?placepointid=1028&zx_hjfq={zx_hjfq}&cutid={cutid}&type=index&placepointname={placepointname}&storageid=1025&entryid=10&userid={userid}&cuttypeid=1&barcode={number_qrcode}"
                            # 使用Selenium打开修改后的URL  
                            driver.get(sm)  

                            current_url = driver.current_url  
                            parsed_url = urlparse(current_url)  
                            query_params = parse_qs(parsed_url.query)  
                    except json.JSONDecodeError:
                        print("响应内容不是有效的JSON格式")
                        print(f"原始响应内容: {response.text[:200]}...")  # 打印前200字符用于调试
                    except Exception as e:
                        print(f"请求处理过程中发生异常: {str(e)}")
                else:
                    print(f"请求失败，状态码: {response.status_code}")

                time.sleep(1)
                if len(number_str) == 1:     
                        # 构建XPath表达式  
                    button_xpath = f'//button[@number="{number_str}"]'  
                    
                        # 使用Selenium查找并点击按钮  
                    button = driver.find_element(By.XPATH, button_xpath)  
                    button.click()
                else:  
                # 如果数字长度大于1，则拆分并依次点击每个数字对应的按钮  
                # 拆分数字为单个字符（数字）  
                    digits = list(number_str) 

                    print("两位数")
                    # 拆分数字为单个字符  
                    digits = list(number_str)
                    for digit in digits:  
                        # 构建XPath表达式  
                        button_xpath = f'//button[@number="{digit}"]'  
                        
                            # 使用Selenium查找并点击按钮  
                        button = driver.find_element(By.XPATH, button_xpath)  
                        button.click()

                # 点击"保存"按钮  
                try:  
                        # 假设"保存"按钮有一个独特的class属性，或者你可以使用其他属性来定位它  
                        save_button_xpath = '//button[contains(@onclick, "add(this)")]'  
                        # 或者，如果"保存"按钮有一个独特的ID或属性，你可以这样写：  
                        # save_button_xpath = '//button[@id="save-button"]'  
                        
                        save_button = driver.find_element(By.XPATH, save_button_xpath)  
                        save_button.click()  
                        print("已点击保存按钮")
                        time.sleep(2)
                        caozuo(driver)
            


                except NoSuchElementException:  
                        print("未找到保存按钮")    
                    
               
            except Exception as e:
                print(f"请求发起不成功: {e}")




        #详细的操作
        def caozuo(driver):
            

            # 在新页面上找到并点击<input>元素  
            search_input = driver.find_element(By.CSS_SELECTOR, 'div.seach3 > input[type="text"]')  
            search_input.click()  # 模拟点击输入框  
            print("输入框点击成功！")


            try:
                # 等待 <ul id="groupList"> 加载完成  
                group_list = WebDriverWait(driver, 10).until(  
                        EC.presence_of_element_located((By.ID, "groupList"))  
                    )
                # 获取所有的 li 元素   
                lis = group_list.find_elements(By.TAG_NAME, "li")  
                
                # 打印 li 元素的数量  
                print(f"总共有 {len(lis)} 个 <li> 元素")    
                # 查找第一个 <li> 元素下的 <span> 元素，并获取其 goodsid 属性值  
                first_li = group_list.find_elements(By.TAG_NAME, "li")[0]  # 注意这里使用了复数形式的 find_elements  
                goodsid_span = first_li.find_element(By.XPATH, ".//span[@goodsid]")  
                goodsid_value = goodsid_span.get_attribute("goodsid")
                print(f"获取到的 goodsid 值是: {goodsid_value}")
                
                requst(goodsid_value,cutid,zx_hjfq,userid,placepointname)



            except  Exception as e: 
                print(f"没有需要盘点的东西")   

                # 再次后退一步
                time.sleep(1)
                print('后退一步')  
                driver.back()
                time.sleep(1)
                print('后退一步')  
                driver.back()
                return False
                



        for index in range(element_len):
           

        
            try:  
                time.sleep(2)
                element = driver.find_elements(By.XPATH, "//img[@zx_hjfq]")[index]  # 每次迭代都重新查找元素
                hide_elements_by_class(driver, 'doorboxNum')  
                hide_elements_by_class(driver, 'doorbox_r')  
                set_element_styles(driver, 'demo_label', '20px', '0') 
                WebDriverWait(driver, 10).until(EC.element_to_be_clickable(element))  
                element.click()  
                print("选择按钮点击成功")  
                try:  
                    doorfoot_div = WebDriverWait(driver, 10).until(  
                        EC.presence_of_element_located((By.CSS_SELECTOR, 'div.doorFoot'))  
                    )  
                    inventory_li = WebDriverWait(driver, 10).until(  
                        EC.element_to_be_clickable((By.CSS_SELECTOR, 'div.doorFoot li[onclick="mdpd_2()"]'))  
                    )  
                    
                    inventory_li.click()  
                    print("'盘点' 按钮点击成功！")
                    try:  
                        time.sleep(3)
                        wait = WebDriverWait(driver, 3)  
                        list_item = wait.until(EC.visibility_of_element_located((By.CSS_SELECTOR, 'ul#groupList > li')))  
    
                        panel_element = driver.find_element(By.CSS_SELECTOR, 'div.panel.panel-default')  
                        
                        panel_html = panel_element.get_attribute('outerHTML')  
                        
                        nocut_count_match = re.search(r'未盘点【(\d+)】', panel_html) 
                        
                        #获取参数
                        time.sleep(1)
                        # 获取并打印当前页面的URL  
                        current_url = driver.current_url  
        
                        # 解析URL  
                        parsed_url = urlparse(current_url)  
                        # 解析查询字符串  
                        query_params = parse_qs(parsed_url.query)  
                        
                        # 从解析后的字典中获取cutid和zx_hjfq  
                        cutid = query_params.get('cutid', [None])[0]  # 使用[0]来确保返回的是列表的第一个元素  
                        zx_hjfq = query_params.get('zx_hjfq', [None])[0]  
                        userid = query_params.get('userid', [None])[0] 
                        placepointname = query_params.get('placepointname', [None])[0] 




                        


                        if nocut_count_match:  
                            nocut_count_str = nocut_count_match.group(1)  # 获取匹配到的数字字符串  
                            nocut_count = int(nocut_count_str)  # 将数字字符串转换为整数  
                            print(nocut_count)
                            if nocut_count==0:
                                print("可盘点数量为0，正在结束循环，退回上一步")
                                time.sleep(5)
                                driver.back()
                                time.sleep(5)
                                driver.back()
                                continue
                            
                            else:
                                # 使用for循环执行nocut_count次操作  
                                for i in range(nocut_count):  
                                    print(f"正在执行的第 {i+1} 次操作")  
                                    # 在这里添加你需要执行的操作
                                    if not caozuo(driver):
                                        break
                        else:  
                            print("未找到未盘点的数量")  


                    except Exception as e:  
                        print(f"为空，不需要盘点")  
                        # 后退一步  
                        driver.back()  
                except Exception as e:  
                    print(f"点击'盘点'按钮时发生错误: {e}")  
                    
            except Exception as e:  
                print(f"选择出错: {e}")  
                raise  # 重新抛出异常，让外层处理

        print("盘点完成")
        return True
        
    finally:
        # 确保driver被正确关闭
        try:
            driver.quit()
        except:
            pass

# 主循环
success = False
while retries < max_retries:
    try:
        success = run_pandian()
        if success:
            break
    except Exception as e:
        print(f"盘点过程中发生错误: {e}")
        retries += 1
        if retries >= max_retries:
            print(f"已达到最大重试次数({max_retries})，放弃执行。")
            break
    time.sleep(2)

if not success:
    print("盘点工具执行失败")
else:
    print("盘点工具执行完成")
