// ==UserScript==
// @name         YouTube TTS 中文配音辅助 (MiMo TTS)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  解析本地 SRT 字幕，调用 MiMo TTS 接口生成中文语音，并根据 YouTube 视频播放状态进行动态倍速和音画同步，辅助学习。
// @author       You
// @match        *://*.youtube.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      token-plan-cn.xiaomimimo.com
// @connect      translate.googleapis.com
// ==/UserScript==

(function() {
    'use strict';

    // ==========================================
    // 配置信息 (Configuration)
    // ==========================================
    const CONFIG = {
        API_URL: 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
        API_KEY: 'tp-c68023i15td7bogn098591k51hbi00wznicmaqz43lp3gfj7',
        VOICE: '冰糖', // 可选: 冰糖, 茉莉, 苏打, 白桦
        CONCURRENCY: 20 // 接口请求并发数（串行请求避免触发限流）
    };

    // ==========================================
    // 全局状态 (State)
    // ==========================================
    let subtitles = []; // 存储字幕数组: { index, start, end, text, audioData, status }
    let isEnabled = false;
    let isMuteOriginal = false;
    let currentSubIndex = -1;
    let currentAudio = null;
    let videoElement = null;

    // ==========================================
    // UI 面板渲染 (UI Rendering)
    // ==========================================
    GM_addStyle(`
        #tts-helper-panel {
            position: fixed;
            top: 60px;
            right: 20px;
            width: 300px;
            background: rgba(28, 28, 28, 0.95);
            color: #fff;
            border: 1px solid #444;
            border-radius: 8px;
            padding: 15px;
            z-index: 999999;
            font-family: Arial, sans-serif;
            font-size: 13px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
            backdrop-filter: blur(5px);
        }
        #tts-helper-panel h3 { margin: 0 0 10px 0; font-size: 16px; border-bottom: 1px solid #555; padding-bottom: 5px; }
        .tts-row { margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
        .tts-row input[type="file"] { width: 100%; font-size: 12px; }
        .tts-status { font-size: 12px; color: #aaa; margin-top: 10px; word-break: break-all; }
        .tts-btn { background: #cc0000; color: white; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer; }
        .tts-btn:hover { background: #ff0000; }
        .tts-btn:disabled { background: #555; cursor: not-allowed; }
    `);

    function createUI() {
        if (document.getElementById('tts-helper-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'tts-helper-panel';

        // 标题
        const title = document.createElement('h3');
        title.textContent = '🎧 TTS 配音学习助手';
        panel.appendChild(title);

        // 自动提取字幕行
        const rowAuto = document.createElement('div');
        rowAuto.className = 'tts-row';
        const autoBtn = document.createElement('button');
        autoBtn.className = 'tts-btn';
        autoBtn.style.width = '100%';
        autoBtn.style.padding = '8px';
        autoBtn.style.fontSize = '14px';
        autoBtn.textContent = '⚡ 一键提取并翻译当前视频字幕';
        rowAuto.appendChild(autoBtn);
        panel.appendChild(rowAuto);

        // 文件上传行 (作为备用)
        const row1 = document.createElement('div');
        row1.className = 'tts-row';
        const fileLabel = document.createElement('span');
        fileLabel.textContent = '备用上传: ';
        fileLabel.style.fontSize = '12px';
        fileLabel.style.color = '#aaa';
        fileLabel.style.whiteSpace = 'nowrap';
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.id = 'tts-srt-upload';
        fileInput.accept = '.srt';
        row1.appendChild(fileLabel);
        row1.appendChild(fileInput);
        panel.appendChild(row1);

        // 控制复选框行
        const row2 = document.createElement('div');
        row2.className = 'tts-row';
        
        const labelEnable = document.createElement('label');
        const checkEnable = document.createElement('input');
        checkEnable.type = 'checkbox';
        checkEnable.id = 'tts-enable';
        checkEnable.disabled = true;
        labelEnable.appendChild(checkEnable);
        labelEnable.appendChild(document.createTextNode(' 开启配音'));
        row2.appendChild(labelEnable);

        const labelMute = document.createElement('label');
        const checkMute = document.createElement('input');
        checkMute.type = 'checkbox';
        checkMute.id = 'tts-mute-origin';
        labelMute.appendChild(checkMute);
        labelMute.appendChild(document.createTextNode(' 静音原视频'));
        row2.appendChild(labelMute);
        
        panel.appendChild(row2);

        // 状态显示
        const statusDiv = document.createElement('div');
        statusDiv.className = 'tts-status';
        statusDiv.id = 'tts-status';
        statusDiv.textContent = '状态：请上传 SRT 字幕文件';
        panel.appendChild(statusDiv);

        // 进度显示
        const progressDiv = document.createElement('div');
        progressDiv.className = 'tts-status';
        progressDiv.id = 'tts-progress';
        panel.appendChild(progressDiv);

        document.body.appendChild(panel);

        // 绑定事件
        autoBtn.addEventListener('click', autoFetchSubtitles);
        fileInput.addEventListener('change', handleFileUpload);
        
        checkEnable.addEventListener('change', (e) => {
            isEnabled = e.target.checked;
            if (!isEnabled && currentAudio) {
                currentAudio.pause();
                currentAudio = null;
                currentSubIndex = -1;
            }
        });

        checkMute.addEventListener('change', (e) => {
            isMuteOriginal = e.target.checked;
            if (videoElement) {
                videoElement.muted = isMuteOriginal;
            }
        });
    }

    function updateStatus(msg) {
        document.getElementById('tts-status').innerText = `状态：${msg}`;
    }

    function updateProgress() {
        if (!subtitles || subtitles.length === 0) return;
        const done = subtitles.filter(s => s.audioData).length;
        document.getElementById('tts-progress').innerText = `音频生成进度：${done} / ${subtitles.length}`;
        if (done > 0 && document.getElementById('tts-enable').disabled) {
            document.getElementById('tts-enable').disabled = false;
        }
    }

    // ==========================================
    // SRT 文件解析 (SRT Parsing)
    // ==========================================
    function timeMs(val) {
        const [time, ms] = val.split(',');
        const [h, m, s] = time.split(':');
        return (+h * 3600 + +m * 60 + +s) + (+ms / 1000);
    }

    function parseSRT(data) {
        const regex = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=(?:\r?\n\d+\r?\n\d{2}:\d{2}:\d{2},\d{3})|$)/g;
        let match;
        const result = [];
        while ((match = regex.exec(data)) !== null) {
            let text = match[4].trim().replace(/\r?\n/g, ' ');
            // 过滤掉空文本或特殊标记符号
            text = text.replace(/<[^>]+>/g, '');
            if (text.length > 0) {
                result.push({
                    index: parseInt(match[1]),
                    start: timeMs(match[2]),
                    end: timeMs(match[3]),
                    text: text,
                    audioData: null, // Base64 WAV
                    status: 'pending' // pending | processing | done | error
                });
            }
        }
        return result;
    }

    function handleFileUpload(e) {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function(evt) {
            const content = evt.target.result;
            subtitles = parseSRT(content);
            updateStatus(`成功解析 ${subtitles.length} 条字幕`);
            updateProgress();
            
            // 重置状态
            currentSubIndex = -1;
            if (currentAudio) { currentAudio.pause(); currentAudio = null; }
            
            // 开始请求 TTS
            processTTSQueue();
        };
        reader.readAsText(file);
    }

    // ==========================================
    // ReadFrog 架构移植：噪声过滤、选轨与解析
    // ==========================================

    // 1. 噪声过滤器 (移植自 ReadFrog: noise-filter.ts)
    const NOISE_PATTERNS = [
        /\[.*?\]/g,     // [Music], [Applause], [Speaker 1] 等
        /\(.*?\)/g,     // (Music), (Applause) 等
        /♪.*?♪/g,       // ♪ Music ♪
        /🎵.*?🎵/g,
        /🎶.*?🎶/g,
        /\u200B/g       // 零宽空格
    ];

    function cleanNoise(text) {
        let result = text;
        for (const pattern of NOISE_PATTERNS) {
            result = result.replace(pattern, "");
        }
        return result.replace(/\s+/g, " ").trim();
    }

    // 2. 核心选轨策略 (移植自 ReadFrog: index.ts selectTrack)
    // 优先选择作者人工上传的完整字幕，避免掉入 ASR 机器碎片的陷阱
    function selectBestTrack(tracks) {
        if (!tracks || tracks.length === 0) return null;

        // 优先级 1: 作者人工上传的原文字幕（高质量、完整长句）
        const humanExact = tracks.find(t => t.kind !== 'asr' && !t.name);
        if (humanExact) return humanExact;

        // 优先级 2: 带名称的人工字幕
        const humanWithName = tracks.find(t => t.kind !== 'asr');
        if (humanWithName) return humanWithName;

        // 优先级 3: 实在没有才选机器自动语音识别 (ASR)
        const asr = tracks.find(t => t.kind === 'asr');
        if (asr) return asr;

        return tracks[0];
    }

    // 3. ASR 滚动字幕状态机解析器 (移植自 ReadFrog: scrolling-asr-parser.ts)
    function parseScrollingAsr(events) {
        const result = [];
        const maxLength = 40; // 中文字符限制
        let currentText = "";
        let currentStart = 0;
        let lastSegEnd = 0;
        let isFirstSeg = true;
        let pendingSplit = false;

        const flush = (text, start, end) => {
            const trimmed = cleanNoise(text);
            if (trimmed) {
                const last = result.at(-1);
                if (last && last.end > start / 1000) {
                    last.end = start / 1000;
                }
                result.push({
                    text: trimmed,
                    start: start / 1000,
                    end: end / 1000
                });
            }
        };

        for (const event of events) {
            if (event.aAppend === 1) {
                if (currentText) {
                    lastSegEnd = event.tStartMs + (event.dDurationMs || 0);
                    if (pendingSplit) {
                        flush(currentText, currentStart, lastSegEnd);
                        currentText = "";
                        isFirstSeg = true;
                        pendingSplit = false;
                    }
                }
                continue;
            }

            if (!event.segs || event.segs.length === 0) continue;

            if (pendingSplit && currentText) {
                flush(currentText, currentStart, lastSegEnd);
                currentText = "";
                isFirstSeg = true;
                pendingSplit = false;
            }

            const segs = event.segs;
            for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                const text = seg.utf8 || "";
                if (!text.trim()) continue;

                const segStart = event.tStartMs + (seg.tOffsetMs || 0);

                if (isFirstSeg) {
                    currentStart = segStart;
                    isFirstSeg = false;
                }

                // 英文单词间智能补充空格，防止"Helloworld"
                if (currentText && text && !currentText.endsWith(" ") && !text.startsWith(" ")) {
                    currentText += " ";
                }
                currentText += text;

                const nextOffset = segs[i + 1]?.tOffsetMs;
                lastSegEnd = nextOffset !== undefined
                    ? Math.max(segStart + 200, event.tStartMs + nextOffset)
                    : Math.max(segStart + 200, event.tStartMs + (event.dDurationMs || 0));

                const trimmedSeg = text.trim();
                const isEnd = /[。！？.!?]$/.test(trimmedSeg);
                const isComma = /[，,]$/.test(trimmedSeg);
                
                // 智能断句增强 (TTS 呼吸感优化)：
                // 1. 遇到明确句末标点 (句号、问号等) 必断
                // 2. 遇到逗号，且当前累积长度已达到 25 字 (适合 TTS 换气) 必断
                // 3. 极限硬上限 45 字 必断
                if (isEnd || (isComma && currentText.length > 25) || currentText.length >= 45) {
                    pendingSplit = true;
                }
            }
        }

        if (currentText) {
            flush(currentText, currentStart, lastSegEnd);
        }
        return result;
    }

    // 4. 标准字幕解析器 (移植自 ReadFrog: standard-parser.ts)
    function parseStandard(events) {
        const segments = [];
        for (const event of events) {
            if (!event.segs || event.tStartMs === undefined) continue;
            const text = cleanNoise(event.segs.map(s => s.utf8 || '').join(''));
            if (!text) continue;

            const start = event.tStartMs / 1000;
            const end = (event.tStartMs + (event.dDurationMs || 2000)) / 1000;
            segments.push({ text, start, end });
        }
        return segments;
    }

    // ==========================================
    // 原文提取与 Google 翻译控制流
    // ==========================================
    async function autoFetchSubtitles() {
        updateStatus("正在分析最佳字幕轨道...");
        try {
            const player = document.getElementById('movie_player');
            if (!player || typeof player.getPlayerResponse !== 'function') {
                updateStatus("错误：未找到 YouTube 播放器实例");
                return;
            }

            const response = player.getPlayerResponse();
            const captionTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

            if (!captionTracks || captionTracks.length === 0) {
                updateStatus("错误：当前视频没有可用字幕");
                return;
            }

            // 优先选人工上传字幕 (原文)
            const chosenTrack = selectBestTrack(captionTracks);
            console.log("[TTS Helper] 优选字幕轨道:", chosenTrack);

            // 取消 YouTube 自带的 &tlang=zh-Hans，直接获取原汁原味的原文字幕
            const originUrl = chosenTrack.baseUrl + '&fmt=json3';
            updateStatus(`选中[${chosenTrack.kind === 'asr' ? 'AI生成' : '作者原稿'}]轨道，正在获取原文...`);

            const subRes = await fetch(originUrl);
            const textData = await subRes.text();
            const subJson = JSON.parse(textData);

            if (!subJson?.events) {
                updateStatus("错误：字幕返回内容为空");
                return;
            }

            // 根据是否是 ASR 分流解析原文
            const isAsr = chosenTrack.kind === 'asr' || subJson.events.some(e => e.aAppend === 1);
            const parsedFragments = isAsr ? parseScrollingAsr(subJson.events) : parseStandard(subJson.events);

            // 重新引入并优化：智能拼接算法 (解决 381 条碎片问题，合成完美长句)
            const mergedFragments = smartMergeSubtitles(parsedFragments);

            subtitles = mergedFragments.map((item, idx) => ({
                index: idx + 1,
                start: item.start,
                end: item.end,
                text: item.text,
                audioData: null,
                status: 'pending'
            }));

            updateStatus(`智能拼合完成，共 ${subtitles.length} 条。正在调用 Google 翻译...`);
            
            // 执行批量翻译 (原文 -> 中文)
            await translateSubtitlesArray(subtitles);

            updateStatus(`翻译并解析完成！共 ${subtitles.length} 条中文字幕`);
            updateProgress();

            currentSubIndex = -1;
            if (currentAudio) { currentAudio.pause(); currentAudio = null; }

            // 翻译完成后，开始请求 TTS 语音
            processTTSQueue();

        } catch (e) {
            console.error("[TTS Helper] 提取或翻译失败:", e);
            updateStatus("提取或翻译出错，请查看 F12 控制台");
        }
    }

    // 智能字幕合并算法 (确保送给翻译和 TTS 的都是完整句子，而非无意义碎词)
    function smartMergeSubtitles(fragments) {
        const result = [];
        let currentSub = null;

        for (let frag of fragments) {
            if (!currentSub) {
                currentSub = { ...frag };
                continue;
            }

            const gap = frag.start - currentSub.end;
            const currentTextLength = currentSub.text.length;
            const isEndWithPunc = /[。！？.!?]$/.test(currentSub.text.trim());
            const isComma = /[，,]$/.test(currentSub.text.trim());
            const isTooLong = currentTextLength > 50;

            // 规则：时间间隔小，且没有断句标点，且没超长，就合并
            if (gap < 1.5 && !isEndWithPunc && !(isComma && currentTextLength > 25) && !isTooLong) {
                // 英文单词拼合时补充空格
                if (!currentSub.text.endsWith(" ") && !frag.text.startsWith(" ")) {
                    currentSub.text += " ";
                }
                currentSub.text += frag.text;
                currentSub.end = Math.max(currentSub.end, frag.end);
            } else {
                result.push(currentSub);
                currentSub = { ...frag };
            }
        }
        if (currentSub) result.push(currentSub);
        return result;
    }

    // Google 批量翻译引擎
    async function translateSubtitlesArray(subs) {
        const batchSize = 15; // 每次翻译 15 句，防止单次请求过大
        for (let i = 0; i < subs.length; i += batchSize) {
            const chunk = subs.slice(i, i + batchSize);
            const textArray = chunk.map(s => s.text);
            const joinedText = textArray.join('\n'); // 使用换行符拼接
            
            updateStatus(`正在翻译: ${Math.min(i + batchSize, subs.length)} / ${subs.length}`);
            
            try {
                const translatedText = await googleTranslate(joinedText);
                const translatedLines = translatedText.split('\n').map(s => s.trim()).filter(s => s);
                
                // 校验行数是否一致
                if (translatedLines.length === chunk.length) {
                    for (let j = 0; j < chunk.length; j++) {
                        chunk[j].text = translatedLines[j];
                    }
                } else {
                    console.warn(`[TTS Helper] 批量翻译行数不匹配 (${translatedLines.length} vs ${chunk.length})，启用逐句翻译兜底...`);
                    // 兜底机制：逐句独立翻译
                    for (let j = 0; j < chunk.length; j++) {
                        chunk[j].text = await googleTranslate(chunk[j].text);
                        // 避免并发过高
                        await new Promise(r => setTimeout(r, 200));
                    }
                }
            } catch(err) {
                console.error("[TTS Helper] 翻译批次失败:", err);
            }
            // 保护性延迟，防止触发 Google 接口 429 限制
            await new Promise(r => setTimeout(r, 800));
        }
    }

    // 调用 Google Translate 免费接口 (利用油猴突破跨域)
    function googleTranslate(text) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8'
                },
                data: 'q=' + encodeURIComponent(text),
                onload: function(res) {
                    try {
                        const json = JSON.parse(res.responseText);
                        let result = '';
                        // json[0] 包含翻译片段数组
                        if (json && json[0]) {
                            json[0].forEach(item => {
                                if (item[0]) result += item[0];
                            });
                        }
                        resolve(result.trim());
                    } catch(e) {
                        reject("JSON 解析失败");
                    }
                },
                onerror: function(err) {
                    reject(err);
                }
            });
        });
    }

    // ==========================================
    // API 请求队列 (API Request Queue)
    // ==========================================
    async function processTTSQueue() {
        for (let i = 0; i < subtitles.length; i++) {
            const sub = subtitles[i];
            if (sub.status === 'pending') {
                sub.status = 'processing';
                
                let retryCount = 0;
                let success = false;
                
                // 增加最多 3 次的失败重试机制
                while (retryCount < 3 && !success) {
                    try {
                        const audioData = await fetchTTS(sub.text);
                        sub.audioData = audioData;
                        sub.status = 'done';
                        success = true;
                        updateProgress();
                    } catch (err) {
                        retryCount++;
                        console.warn(`[TTS Helper] 第 ${i} 条字幕请求失败 (重试 ${retryCount}/3):`, err);
                        if (retryCount >= 3) {
                            sub.status = 'error';
                        }
                        // 如果失败，强制等待 2 秒再重试
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
                
                // 正常的请求间隙，保护 API 不被并发封禁
                await new Promise(r => setTimeout(r, 500));
            }
        }
        updateStatus("所有音频处理完成");
    }

    function fetchTTS(text) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.API_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'api-key': CONFIG.API_KEY,
                    'Authorization': `Bearer ${CONFIG.API_KEY}`
                },
                data: JSON.stringify({
                    model: "mimo-v2.5-tts",
                    messages: [
                        {
                            "role": "user",
                            "content": "用较快且连贯的语速朗读，保持清晰自然。"
                        },
                        {
                            "role": "assistant",
                            "content": text
                        }
                    ],
                    audio: {
                        "format": "wav",
                        "voice": CONFIG.VOICE
                    }
                }),
                onload: function(response) {
                    if (response.status === 200) {
                        try {
                            const res = JSON.parse(response.responseText);
                            if (res.choices && res.choices[0] && res.choices[0].message.audio) {
                                resolve(res.choices[0].message.audio.data);
                            } else {
                                reject("Invalid API Response Structure");
                            }
                        } catch (e) {
                            reject("Parse JSON Error");
                        }
                    } else {
                        reject(`HTTP Error: ${response.status}`);
                    }
                },
                onerror: function(error) {
                    reject(error);
                }
            });
        });
    }

    // ==========================================
    // 音画同步与播放控制 (Playback & Sync)
    // ==========================================
    function setupVideoHooks() {
        videoElement = document.querySelector('video');
        if (!videoElement) return;

        // 根据设置保持静音状态
        videoElement.muted = isMuteOriginal;

        videoElement.addEventListener('timeupdate', () => {
            if (!isEnabled || subtitles.length === 0) return;
            
            const ct = videoElement.currentTime;
            
            // 查找当前时间所处的字幕区间
            const activeSubIndex = subtitles.findIndex(s => ct >= s.start && ct <= s.end);

            if (activeSubIndex !== -1 && activeSubIndex !== currentSubIndex) {
                // 进入新的字幕
                playAudioForSubtitle(activeSubIndex);
            } else if (activeSubIndex === -1 && currentAudio && !currentAudio.paused) {
                // 如果当前时间不在任何字幕内，但音频还在放，由于我们做了倍速压缩，理论上不会越界
                // 但为了严谨，如果超过当前字幕的 end 较多，可以强制切断
                const curSub = subtitles[currentSubIndex];
                if (curSub && ct > curSub.end + 0.5) {
                    currentAudio.pause();
                }
            }
        });

        // 用户拖动进度条，停止当前发音并重置
        videoElement.addEventListener('seeking', () => {
            if (currentAudio) {
                currentAudio.pause();
                currentAudio = null;
            }
            currentSubIndex = -1;
        });

        // 视频暂停时同步暂停音频
        videoElement.addEventListener('pause', () => {
            if (currentAudio && !currentAudio.paused) {
                currentAudio.pause();
            }
        });

        // 视频恢复播放时同步恢复音频
        videoElement.addEventListener('play', () => {
            if (isEnabled && currentAudio && currentAudio.paused) {
                // 确保仍在当前字幕区间才恢复
                const ct = videoElement.currentTime;
                const curSub = subtitles[currentSubIndex];
                if (curSub && ct >= curSub.start && ct <= curSub.end) {
                    currentAudio.play();
                }
            }
        });

        // 视频改变倍速时，动态调整音频倍速
        videoElement.addEventListener('ratechange', () => {
            if (currentAudio && currentSubIndex !== -1) {
                adjustAudioPlaybackRate(currentAudio, subtitles[currentSubIndex], videoElement.playbackRate);
            }
        });
    }

    function playAudioForSubtitle(index) {
        if (currentAudio) {
            currentAudio.pause();
        }
        
        currentSubIndex = index;
        const sub = subtitles[index];

        if (sub.audioData) {
            currentAudio = new Audio("data:audio/wav;base64," + sub.audioData);
            
            // 元数据加载完毕后才可以获取 audio.duration 并计算倍速
            currentAudio.onloadedmetadata = () => {
                adjustAudioPlaybackRate(currentAudio, sub, videoElement.playbackRate);
                
                // 如果当前视频没有暂停，才播放
                if (!videoElement.paused) {
                    currentAudio.play().catch(e => console.log("Audio play prevented:", e));
                }
            };
        } else {
            console.log(`[TTS Helper] Subtitle ${index} audio not ready yet.`);
        }
    }

    /**
     * 核心逻辑：动态计算并调整配音的倍速
     * @param {HTMLAudioElement} audio 
     * @param {Object} sub 字幕对象 (含有 start, end)
     * @param {Number} videoRate 当前视频本身的倍速
     */
    function adjustAudioPlaybackRate(audio, sub, videoRate) {
        const audioDuration = audio.duration;
        let subDuration = sub.end - sub.start;
        
        // 安全防范：防止极短碎片导致除以 0 产生 Infinity (导致 DOM 报错)
        if (subDuration <= 0.1) subDuration = 0.1;
        if (!audioDuration || isNaN(audioDuration)) return;
        
        // 计算音频对齐该字幕所需的基础倍速 (如果音频过长则必须加速)
        let baseRate = audioDuration / subDuration;
        
        // 如果中文音频比原本的字幕时间短，则不进行减速（减速会导致声音拖泥带水，听感差）
        // 我们只需让它用 1.0 倍速正常播完即可
        if (baseRate < 1.0) {
            baseRate = 1.0;
        }

        // 最终倍速 = 基础倍速 * 视频的播放倍速
        let finalRate = baseRate * videoRate;

        // 浏览器一般支持 0.25 到 4.0 (部分 5.0) 的倍速，设置上限避免报错
        if (finalRate > 4.0) finalRate = 4.0;
        
        audio.playbackRate = finalRate;
    }

    // ==========================================
    // 初始化逻辑 (Initialization)
    // ==========================================
    function init() {
        console.log("[TTS Helper] 脚本已启动，正在监听页面...");
        
        // 核心心跳检测：定期检查 UI 是否存在，以及 video 元素是否变化
        // 彻底解决 YouTube SPA 路由跳转导致的 DOM 丢失问题
        setInterval(() => {
            // 确保 body 存在且 UI 未被 YouTube 框架意外移除
            if (document.body && !document.getElementById('tts-helper-panel')) {
                console.log("[TTS Helper] 正在注入 / 恢复 UI 面板...");
                createUI();
            }
            
            const v = document.querySelector('video');
            if (v && v !== videoElement) {
                console.log("[TTS Helper] 探测到有效 Video 元素，重新绑定同步事件...");
                setupVideoHooks();
            }
        }, 1500);
    }

    // Tampermonkey 默认在 document-idle 运行，但不排除有些环境下 body 还没渲染完
    // 使用轮询确保 document.body 存在后再启动主逻辑
    const startCheck = setInterval(() => {
        if (document.body) {
            clearInterval(startCheck);
            init();
        }
    }, 100);

})();
