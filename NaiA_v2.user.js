    // ==UserScript==
// @name         NAI Archive
// @namespace    https://github.com/Dflashh/
// @version      1.0.15
// @description  NovelAI 컨셉·자료·메모를 한곳에 보관하고 공유하는 개인 아카이브입니다.
// @icon         https://cdn.jsdelivr.net/gh/Dflashh/Nai@main/Icon/NaiA.webp
// @downloadURL  https://raw.githubusercontent.com/mynameislovesong/NAIA/main/NaiA_v2.user.js
// @updateURL    https://raw.githubusercontent.com/mynameislovesong/NAIA/main/NaiA_v2.user.js
// @match        https://novelai.net/*
// @match        https://*.notion.site/*
// @match        https://notion.site/*
// @match        https://*.notion.so/*
// @match        https://notion.so/*
// @match        https://app.notion.com/*
// @author       Dflashh
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      generativelanguage.googleapis.com
// @connect      oauth2.googleapis.com
// @connect      googleapis.com
// @connect      www.gstatic.com
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    const APP_NAME = 'NAI Archive';
    const APP_VERSION = '1.0.15';
    const BUTTON_ID = 'nai-concept-loader-button';
    const MODAL_ID = 'nai-concept-loader-modal';
    const SETTINGS_KEY = 'naiConceptLoader.settings';
    const LIBRARY_KEY = 'naiConceptLoader.library';
    const LIBRARY_CATEGORY_KEY = 'naiConceptLoader.libraryCategories';
    const RESOURCE_KEY = 'naiConceptLoader.resources';
    const RESOURCE_CATEGORY_KEY = 'naiConceptLoader.resourceCategories';
    const MEMO_KEY = 'naiConceptLoader.memos';
    const MEMO_CATEGORY_KEY = 'naiConceptLoader.memoCategories';
    const SHARE_CODE_PREFIX = 'NAICL1:';
    const DEFAULT_MODEL = 'gemini-3.8-flash';
    const NOTION_MAX_DEPTH = 4;
    const NOTION_MAX_PAGES = 48;
    const NOTION_BROWSER_JOB_KEY = 'naiConceptLoader.notionBrowserCrawlerJob';
    const NOTION_BROWSER_MAX_WAIT_MS = 180000;
    const NOTION_BROWSER_PAGE_SETTLE_MS = 12000;
    const NOTION_NETWORK_MAX_WAIT_MS = 26000;
    const NOTION_NETWORK_IDLE_DONE_MS = 4500;
    const NOTION_NETWORK_MAX_CAPTURE_CHARS = 2600000;

    const DEFAULT_SETTINGS = {
        provider: 'gemini',

        geminiKey: '',
        geminiModel: DEFAULT_MODEL,

        vertexJson: '',
        vertexProjectId: '',
        vertexLocation: 'global',
        vertexModel: DEFAULT_MODEL,

        firebaseConfig: '',
        firebaseBackend: 'vertex',
        firebaseLocation: 'global',
        firebaseModel: DEFAULT_MODEL,

    };

    const PAGE_WINDOW =
        typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    const GM_XHR =
        typeof GM_xmlhttpRequest === 'function'
            ? GM_xmlhttpRequest
            : (typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
                ? GM.xmlHttpRequest.bind(GM)
                : null);

    // Install the image-generation bridge before NovelAI's app bundle has a chance
    // to capture its own reference to window.fetch. The function declaration is
    // hoisted; active-reference data is only read later, when a generation occurs.
    installNaiArchiveReferenceInterceptor();
    setTimeout(() => installNaiArchiveReferenceSync(), 0);

    const tokenCache = Object.create(null);
    let firebaseSdkPromise = null;
    const firebaseAppCache = Object.create(null);
    const firebaseAiCache = Object.create(null);
    const firebaseModelCache = Object.create(null);

    let analysisResults = [];
    let analysisMeta = null;
    let isAnalyzing = false;
    let analysisStatusText = '';
    let analysisUrl = '';
    let analysisResultUnread = false;
    let analysisStatusClearTimer = 0;
    const ANALYSIS_STATE_EVENT = 'nai-concept-loader-analysis-state';

    function notifyGlobalAnalysisState() {
        syncGlobalAnalyzeUi();
        try {
            document.dispatchEvent(new CustomEvent(ANALYSIS_STATE_EVENT));
        } catch (_) {}
    }

    function setGlobalAnalysisStatus(message) {
        analysisStatusText = String(message || '');

        if (analysisStatusClearTimer) {
            clearTimeout(analysisStatusClearTimer);
            analysisStatusClearTimer = 0;
        }

        const status = document.querySelector(
            `#${MODAL_ID} #nai-import-status`
        );
        if (status) status.textContent = analysisStatusText;

        if (/^(?:분석 실패|실패|오류|설정 필요)/.test(analysisStatusText)) {
            analysisStatusClearTimer = setTimeout(() => {
                analysisStatusText = '';
                const current = document.querySelector(`#${MODAL_ID} #nai-import-status`);
                if (current) current.textContent = '';
                analysisStatusClearTimer = 0;
            }, 7000);
        }
    }

    function triggerAnalysisCompletionAnimation() {
        analysisResultUnread = true;
        syncGlobalAnalyzeUi();
    }

    function acknowledgeAnalysisCompletion() {
        if (!analysisResultUnread) return;
        analysisResultUnread = false;
        syncGlobalAnalyzeUi();
    }

    function syncGlobalAnalyzeUi() {
        const modal = document.getElementById(MODAL_ID);
        const button = modal?.querySelector('[data-action="analyze"]');

        if (button) {
            button.disabled = isAnalyzing;
            button.innerHTML = isAnalyzing
                ? '<span class="nai-loading">분석 중</span>'
                : 'URL 가져오기';
        }

        const status = modal?.querySelector('#nai-import-status');
        if (status && analysisStatusText) {
            status.textContent = analysisStatusText;
        }

        const urlInput = modal?.querySelector('#nai-import-url');
        if (urlInput && analysisUrl && !urlInput.value.trim()) {
            urlInput.value = analysisUrl;
        }

        const navButton = document.getElementById(BUTTON_ID);
        if (navButton) {
            if (!navButton.querySelector('.nai-nav-diamond')) {
                navButton.innerHTML = '<span class="nai-nav-diamond" aria-hidden="true">✦</span>';
            }
            navButton.classList.toggle('nai-analyzing', isAnalyzing);
            navButton.classList.toggle(
                'nai-analysis-complete',
                !isAnalyzing && analysisResultUnread
            );

            const navLabel = isAnalyzing
                ? `${APP_NAME} · 백그라운드 분석 중`
                : analysisResultUnread
                    ? `${APP_NAME} · 분석 완료 · 확인 필요`
                    : APP_NAME;

            navButton.title = navLabel;
            navButton.setAttribute('aria-label', navLabel);
        }
    }

    const IS_NOTION_RUNTIME =
        /(^|\.)notion\.(?:site|so)$/i.test(location.hostname) ||
        /^app\.notion\.com$/i.test(location.hostname);

    if (IS_NOTION_RUNTIME) {
        const notionRuntimeJob = notionCrawlerJobRead();
        const notionRuntimeRunner = notionRuntimeJob?.mode === 'network-intercept'
            ? runNotionNetworkInterceptorHelper
            : runNotionRenderedCrawlerHelper;

        notionRuntimeRunner().catch(error => {
            try {
                const job = GM_getValue(NOTION_BROWSER_JOB_KEY, null);
                if (job && job.status === 'running') {
                    GM_setValue(NOTION_BROWSER_JOB_KEY, {
                        ...job,
                        status: 'error',
                        error: error?.message || String(error),
                        updatedAt: Date.now()
                    });
                }
            } catch (_) {}
        });
        return;
    }

    GM_addStyle(`
        /*
         * 상단 버튼의 껍데기는 현재 NovelAI menu 버튼의 className을 그대로 복제한다.
         * 여기서는 아이콘/상태 애니메이션만 담당해서 PC·모바일 반응형 디자인을 따라간다.
         */
        #${BUTTON_ID} {
            cursor: pointer;
            flex: 0 0 auto;
        }

        #${BUTTON_ID}.nai-nav-legacy {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            align-self: stretch;
            box-sizing: border-box;
            min-height: 34px;
            min-width: 42px;
            padding: 0 10px;
            border: 0;
            background: transparent;
        }

        #${BUTTON_ID} .nai-nav-diamond {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 16px;
            height: 16px;
            font-size: 18px;
            line-height: 16px;
            color: var(--nai-nav-diamond-color, currentColor);
            transform-origin: 50% 50%;
            will-change: transform, opacity, filter;
        }

        #${BUTTON_ID}.nai-analyzing .nai-nav-diamond {
            animation: nai-diamond-work 1.45s ease-in-out infinite;
        }

        #${BUTTON_ID}.nai-analysis-complete .nai-nav-diamond {
            animation: nai-diamond-complete 3.2s ease-in-out infinite;
        }

        @keyframes nai-diamond-work {
            0% { transform: rotate(0deg); }
            48% { transform: rotate(360deg); }
            100% { transform: rotate(360deg); }
        }

        @keyframes nai-diamond-complete {
            0%, 100% { opacity: 1; filter: brightness(1); }
            50% { opacity: 0.22; filter: brightness(1.55); }
        }

        .nai-loader-overlay {
            position: fixed;
            inset: 0;
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(0, 0, 0, 0.68);
        }

        .nai-loader-modal {
            width: min(780px, calc(100vw - 28px));
            height: calc(100vh - 36px);
            max-height: calc(100vh - 36px);
            overflow: hidden;
            box-sizing: border-box;
            background: #202234;
            color: #fff;
            border: 1px solid #353850;
            border-radius: 8px;
            box-shadow: 0 20px 70px rgba(0, 0, 0, 0.55);
            font-family: inherit;
            display: flex;
            flex-direction: column;
        }

        .nai-loader-header {
            flex: 0 0 auto;
            display: flex;
            align-items: center;
            justify-content: space-between;
            min-height: 28px;
            padding: 7px 14px 0;
        }

        .nai-loader-title {
            display: inline-flex;
            align-items: baseline;
            gap: 7px;
            min-width: 0;
            font-size: 15px;
            font-weight: 700;
            line-height: 1.1;
        }

        .nai-loader-version {
            color: #858aa6;
            font-size: 10px;
            font-weight: 500;
            letter-spacing: 0.01em;
            white-space: nowrap;
        }

        .nai-loader-close {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            width: 26px;
            height: 26px;
            border: 0;
            background: transparent;
            color: #aaaec7;
            cursor: pointer;
            font-size: 20px;
            line-height: 1;
            padding: 0;
        }

        .nai-loader-tabs {
            flex: 0 0 auto;
            display: flex;
            gap: 4px;
            padding: 7px 14px 0;
            border-bottom: 1px solid #353850;
            overflow-x: auto;
            overflow-y: hidden;
            scrollbar-width: thin;
        }

        .nai-loader-tab {
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            border: 0;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: #9ea3bf;
            padding: 10px 13px;
            cursor: pointer;
            font: inherit;
            font-size: 13px;
            font-weight: 700;
        }

        .nai-loader-tab:hover {
            color: #fff;
        }

        .nai-loader-tab.active {
            color: #fff;
            border-bottom-color: #9773ff;
        }

        .nai-loader-content {
            flex: 1 1 auto;
            overflow-y: auto;
            min-height: 300px;
        }

        .nai-loader-panel {
            display: none;
            padding: 18px;
        }

        .nai-loader-panel.active {
            display: block;
        }

        .nai-loader-label {
            display: block;
            margin: 0 0 7px;
            color: #c8cbe0;
            font-size: 13px;
            font-weight: 600;
        }

        .nai-loader-field {
            margin-bottom: 16px;
        }

        .nai-loader-input,
        .nai-loader-textarea,
        .nai-loader-select {
            display: block;
            width: 100%;
            box-sizing: border-box;
            padding: 10px 12px;
            border: 1px solid #3d405c;
            border-radius: 5px;
            background: #181a2a;
            color: #fff;
            font: inherit;
            outline: none;
        }

        #${MODAL_ID} .nai-loader-input,
        #${MODAL_ID} .nai-loader-textarea,
        #${MODAL_ID} .nai-loader-select {
            color: #ffffff !important;
            -webkit-text-fill-color: #ffffff !important;
            caret-color: #ffffff;
        }

        #${MODAL_ID} .nai-loader-input::placeholder,
        #${MODAL_ID} .nai-loader-textarea::placeholder {
            color: #777b92 !important;
            -webkit-text-fill-color: #777b92 !important;
            opacity: 1 !important;
        }

        .nai-loader-textarea {
            min-height: 115px;
            resize: vertical;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12px;
            line-height: 1.55;
        }

        .nai-loader-input:focus,
        .nai-loader-textarea:focus,
        .nai-loader-select:focus {
            border-color: #9773ff;
        }

        .nai-loader-row {
            display: flex;
            gap: 10px;
            align-items: center;
        }

        .nai-loader-grow {
            flex: 1 1 auto;
            min-width: 0;
        }

        .nai-import-action-row {
            justify-content: space-between;
        }

        .nai-import-action-row .nai-loader-action {
            flex: 0 0 auto;
            height: 28px;
            min-height: 28px;
            padding: 0 12px;
        }

        .nai-settings-action-row {
            justify-content: flex-end;
        }

        .nai-analysis-header-row {
            flex-wrap: nowrap;
        }

        .nai-loader-action {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            padding: 9px 13px;
            border: 1px solid #454966;
            border-radius: 5px;
            background: #353850;
            color: #fff;
            cursor: pointer;
            font: inherit;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            text-align: center;
            white-space: nowrap;
            vertical-align: middle;
        }

        .nai-loader-action:hover {
            filter: brightness(1.08);
        }

        .nai-loader-action:disabled {
            cursor: wait;
            opacity: 0.6;
            filter: none;
        }

        .nai-loader-action.primary {
            border-color: #9773ff;
            background: #9773ff;
        }

        .nai-loader-action.danger {
            border-color: #7e4250;
            background: #572d39;
        }

        .nai-loader-action.ghost {
            background: transparent;
        }

        .nai-loader-status {
            min-height: 18px;
            margin-top: 10px;
            color: #aeb2cc;
            font-size: 12px;
            line-height: 1.5;
            white-space: pre-wrap;
        }

        /* 라이브러리/자료실/메모의 일회성 안내는 리스트 아래에 쌓지 않고 토스트로 표시한다. */
        #nai-manual-status,
        #nai-library-status,
        #nai-resource-status,
        #nai-memo-status {
            display: none !important;
            min-height: 0;
            margin: 0;
        }

        .nai-loader-toast {
            position: fixed;
            left: 50%;
            bottom: max(18px, env(safe-area-inset-bottom));
            z-index: 1000002;
            width: max-content;
            max-width: min(620px, calc(100vw - 28px));
            box-sizing: border-box;
            padding: 7px 12px;
            border: 1px solid #4a4f70;
            border-radius: 6px;
            background: rgba(28, 30, 49, 0.96);
            color: #f4f5ff;
            box-shadow: 0 8px 26px rgba(0, 0, 0, 0.38);
            font-size: 12px;
            font-weight: 650;
            line-height: 1.35;
            text-align: center;
            white-space: pre-wrap;
            overflow-wrap: anywhere;
            pointer-events: none;
            opacity: 0;
            transform: translate(-50%, 8px);
            transition: opacity 150ms ease, transform 150ms ease;
        }

        .nai-loader-toast.show {
            opacity: 1;
            transform: translate(-50%, 0);
        }

        .nai-loader-toast.error {
            border-color: #8a4a59;
            background: rgba(72, 37, 47, 0.97);
        }

        .nai-library-toolbar {
            display: flex;
            flex-direction: row;
            align-items: stretch;
            gap: 8px;
            margin-bottom: 14px;
        }

        .nai-toolbar-add-button {
            flex: 0 0 40px;
            width: 40px;
            min-width: 40px;
            min-height: 40px;
            padding: 0;
            border-radius: 5px;
            font-size: 20px;
            font-weight: 500;
            line-height: 1;
        }

        .nai-library-category-bar {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            margin: -6px 0 14px;
            min-height: 24px;
            width: 100%;
        }

        .nai-library-category-filter-group {
            display: flex;
            flex: 1 1 0;
            flex-wrap: wrap;
            align-items: center;
            gap: 6px;
            min-width: 0;
        }

        .nai-library-category-tools {
            display: flex;
            align-items: center;
            gap: 6px;
            margin-left: auto;
            flex: 0 0 auto;
        }

        /* 상단 필터는 활성화된 분류만 또렷하게 보이게 한다. */
        .nai-library-category-filter-group .nai-library-category-chip:not(.active) {
            opacity: 0.46;
            color: #858aa4;
            background: #202235;
        }

        .nai-library-category-filter-group .nai-library-category-chip:not(.active):hover {
            opacity: 0.8;
            color: #d9dcef;
        }

        .nai-library-category-edit-button {
            min-width: 38px;
        }

        .nai-library-category-edit-button.active {
            border-color: #9773ff;
            background: #5b46a8;
            color: #fff;
        }

        .nai-library-category-manager {
            flex: 1 0 100%;
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 6px;
            padding: 8px;
            border: 1px solid #353954;
            border-radius: 5px;
            background: #1b1e31;
        }

        .nai-library-category-manager-row {
            display: flex;
            align-items: center;
            gap: 6px;
            width: 100%;
        }

        .nai-library-category-manager-row .nai-loader-input {
            height: 28px;
            min-height: 28px;
            padding: 4px 8px;
            font-size: 11px;
        }

        .nai-library-category-manager-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            flex: 0 0 auto;
            min-width: 28px;
            height: 28px;
            padding: 0 7px;
            border: 1px solid #454966;
            border-radius: 4px;
            background: #25283b;
            color: #c5c9db;
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
        }

        .nai-library-category-manager-button:hover:not(:disabled) {
            border-color: #656b91;
            background: #30344b;
            color: #fff;
        }

        .nai-library-category-manager-button:disabled {
            opacity: 0.28;
            cursor: default;
        }

        .nai-library-category-manager-button.danger {
            color: #ffadb8;
            border-color: #6c3e4a;
        }

        .nai-library-category-chip {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 23px;
            padding: 0 9px;
            border: 1px solid #454966;
            border-radius: 4px;
            background: #25283b;
            color: #b6bad0;
            cursor: pointer;
            font: inherit;
            font-size: 11px;
            font-weight: 700;
            line-height: 1;
            white-space: nowrap;
        }

        .nai-library-category-chip:hover {
            border-color: #656b91;
            background: #30344b;
            color: #fff;
        }

        .nai-library-category-chip.active {
            border-color: #9773ff;
            background: #5b46a8;
            color: #fff;
        }

        .nai-library-category-chip.nai-category-add {
            min-width: 25px;
            width: 25px;
            padding: 0;
            font-size: 15px;
        }

        .nai-library-card-category-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            min-height: 0;
            margin-top: 9px;
        }

        /* 보기 모드 분류는 헤더 안이 아니라 헤더와 Base Prompt 사이의 독립 행. */
        .nai-library-card-body > .nai-library-card-category-row {
            margin-top: 3px;
            margin-bottom: 12px;
        }

        .nai-library-card-category-row:empty {
            display: none;
        }

        .nai-library-card-category-row .nai-library-category-chip {
            min-height: 20px;
            padding: 0 7px;
            font-size: 10px;
        }

        /* 카드/수정 화면에서는 미선택 분류를 흐리게, 선택 분류만 또렷하게. */
        .nai-library-card-category-row .nai-library-category-chip:not(.active) {
            opacity: 0.42;
            color: #858aa4;
            background: #202235;
        }

        .nai-library-card-category-row .nai-library-category-chip:not(.active):hover {
            opacity: 0.78;
            color: #d9dcef;
        }

        .nai-library-card-category-row .nai-library-category-chip.active {
            opacity: 1;
        }

        /* 접힌 카드는 한 줄 유지: 분류는 펼쳤을 때만 제목 아래 표시. */
        .nai-concept-card.nai-library-card-collapsed .nai-library-card-category-row {
            display: none !important;
        }

        .nai-library-edit-category-field {
            margin-top: 10px;
        }

        .nai-library-category-empty {
            color: #8f95b2;
            font-size: 11px;
        }

        .nai-inline-create-wrap {
            margin-bottom: 14px;
        }

        .nai-inline-create-wrap[hidden] {
            display: none !important;
        }

        .nai-library-list {
            display: grid;
            gap: 10px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        .nai-library-empty {
            padding: 34px 18px;
            border: 1px dashed #454966;
            border-radius: 7px;
            color: #9ea3bf;
            text-align: center;
            line-height: 1.7;
        }

        .nai-concept-card {
            border: 1px solid #353850;
            border-radius: 7px;
            background: #191b2b;
            /* 접힘/펼침에 관계없이 헤더 위치가 절대 움직이지 않도록 동일 패딩 사용. */
            padding: 8px 13px 8px 8px;
            min-height: 0 !important;
            height: auto !important;
            align-self: start;
        }
        /* 접힘/펼침은 아래 본문만 바뀌고 헤더는 완전히 같은 크기/위치를 유지. */
        .nai-concept-card.nai-library-card-collapsed {
            padding: 8px 13px 8px 8px;
        }

        .nai-concept-card-header {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 8px;
        }

        .nai-library-card-summary {
            display: flex;
            align-items: center;
            gap: 8px;
            min-width: 0;
            min-height: 20px;
            cursor: pointer;
        }

        .nai-library-card-summary-main {
            display: flex;
            flex-direction: column;
            align-items: stretch;
            justify-content: center;
            flex: 1 1 auto;
            min-width: 0;
        }

        .nai-library-card-toggle {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            width: 100%;
            min-width: 0;
            color: inherit;
            font: inherit;
            text-align: left;
        }

        .nai-library-card-toggle .nai-concept-name {
            flex: 0 1 auto;
            min-width: 42px;
            max-width: none;
            overflow: hidden;
            text-overflow: clip;
            white-space: nowrap;
            font-size: 13px;
            line-height: 1.15;
        }

        .nai-library-title-marquee-text {
            display: inline-block;
            white-space: nowrap;
            transform: translateX(0);
            will-change: transform;
        }

        .nai-library-card-toggle .nai-concept-name.nai-title-overflowing .nai-library-title-marquee-text {
            animation: nai-library-title-marquee 6.4s ease-in-out infinite;
        }

        @keyframes nai-library-title-marquee {
            0%, 16% {
                transform: translateX(0);
            }
            66%, 84% {
                transform: translateX(var(--nai-library-title-shift, 0px));
            }
            100% {
                transform: translateX(0);
            }
        }

        @media (prefers-reduced-motion: reduce) {
            .nai-library-card-toggle .nai-concept-name.nai-title-overflowing .nai-library-title-marquee-text {
                animation: none;
            }
        }

        .nai-card-note-preview {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            text-align: left;
            color: #9ba0bd;
            font-size: 11px;
            font-weight: 500;
        }

        .nai-card-note-preview[hidden],
        .nai-card-note-separator[hidden] {
            display: none !important;
        }

        .nai-card-note-separator {
            flex: 0 0 auto;
            color: #8f95b2;
            font-size: 11px;
            line-height: 1;
        }

        .nai-library-summary-actions {
            margin-left: auto;
            display: flex;
            flex: 0 0 auto;
            align-items: center;
            justify-content: flex-end;
            gap: 7px;
        }

        .nai-library-summary-actions .nai-loader-action {
            /* 접힘/펼침에서 버튼 크기와 위치가 바뀌지 않도록 하나의 규격만 사용. */
            height: 20px;
            min-height: 20px;
            padding: 0 8px;
            border-radius: 4px;
            font-size: 10px;
            line-height: 1;
        }

        .nai-library-note-body {
            padding-top: 8px;
        }

        .nai-library-note-body[hidden],
        .nai-library-card-body[hidden] {
            display: none !important;
        }

        .nai-library-note-body .nai-note-editor {
            min-height: 72px;
            max-height: 220px;
        }

        .nai-library-card-body {
            padding-top: 8px;
        }

        .nai-concept-name {
            flex: 1 1 auto;
            min-width: 0;
            font-weight: 800;
            font-size: 14px;
            word-break: break-word;
        }

        .nai-concept-footer {
            display: block;
            margin-top: 10px;
        }

        .nai-concept-footer .nai-concept-actions {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-top: 0;
        }

        .nai-concept-action-right {
            margin-left: auto;
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: flex-end;
            gap: 7px;
        }


        /* 라이브러리 보기 모드의 사용/복사/수정/원본/삭제 버튼만 슬림하게. */
        .nai-concept-footer .nai-concept-actions .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 9px;
            border-radius: 4px;
            font-size: 11px;
            line-height: 1;
        }

        .nai-concept-footer .nai-loader-action.nai-library-note-active {
            border-color: #9773ff;
            background: #5b46a8;
            color: #fff;
        }

        .nai-edit-footer-actions {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-top: 12px;
        }

        .nai-edit-footer-actions .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 9px;
            border-radius: 4px;
            font-size: 11px;
            line-height: 1;
        }

        .nai-concept-tags {
            display: block !important;
            padding: 8px 10px;
            margin: 0;
            border-radius: 5px;
            background: #131522;
            color: #d8dbeb;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 12px;
            line-height: 1.55;
            white-space: pre-wrap;
            word-break: break-word;
            text-align: left !important;
            min-height: 0 !important;
            height: auto !important;
            max-height: 150px;
            overflow: auto;
        }

        .nai-concept-actions {
            display: flex;
            flex-wrap: wrap;
            gap: 7px;
            margin-top: 10px;
        }

        .nai-loader-section-title {
            margin: 0 0 9px;
            font-size: 14px;
            font-weight: 800;
        }

        .nai-loader-muted {
            color: #959ab7;
            font-size: 12px;
            line-height: 1.55;
        }

        .nai-duplicate-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            height: 20px;
            box-sizing: border-box;
            padding: 0 7px;
            border: 1px solid rgba(255, 170, 98, 0.6);
            border-radius: 999px;
            background: rgba(255, 142, 61, 0.14);
            color: #ffc18e;
            font-size: 10px;
            font-weight: 800;
            line-height: 1;
            white-space: nowrap;
        }

        .nai-duplicate-badge[hidden] {
            display: none !important;
        }

        .nai-duplicate-warning {
            margin: 0 0 10px;
            padding: 7px 9px;
            border: 1px solid rgba(255, 170, 98, 0.45);
            border-radius: 5px;
            background: rgba(255, 142, 61, 0.1);
            color: #ffc18e;
            font-size: 11px;
            line-height: 1.45;
        }

        .nai-duplicate-warning[hidden] {
            display: none !important;
        }

        .nai-loader-divider {
            height: 1px;
            margin: 18px 0;
            background: #353850;
        }

        .nai-import-result {
            border: 1px solid #3d405c;
            border-radius: 7px;
            padding: 14px;
            background: #191b2b;
        }

        .nai-share-import-preview {
            margin-top: 12px;
        }

        .nai-share-import-preview[hidden] {
            display: none !important;
        }

        .nai-share-import-preview .nai-import-result {
            padding: 12px;
        }

        .nai-share-import-preview .nai-loader-section-title {
            margin-bottom: 12px;
        }

        .nai-share-import-preview .nai-library-card-category-row {
            margin-top: 0;
        }

        .nai-backup-box {
            padding: 12px;
            border: 1px solid #353954;
            border-radius: 7px;
            background: #191b2b;
        }

        .nai-backup-choice-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 7px;
            margin-top: 10px;
        }

        .nai-backup-choice {
            min-width: 72px;
        }

        .nai-backup-choice:not(.active) {
            opacity: 0.48;
            color: #8c90a8;
            background: #202235;
        }

        .nai-backup-actions {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
            margin-top: 12px;
        }

        .nai-backup-section-list {
            display: flex;
            flex-direction: column;
            gap: 10px;
            margin-top: 12px;
        }

        .nai-backup-section {
            border: 1px solid #353954;
            border-radius: 6px;
            background: #171927;
            overflow: hidden;
        }

        .nai-backup-section-head {
            display: flex;
            align-items: center;
            gap: 8px;
            padding: 8px 9px;
            border-bottom: 1px solid #30344d;
        }

        .nai-backup-section-title {
            color: #eef0f8;
            font-size: 12px;
            font-weight: 800;
        }

        .nai-backup-section-count {
            color: #8f94ae;
            font-size: 11px;
            font-weight: 700;
        }

        .nai-backup-section-controls {
            display: flex;
            gap: 6px;
            margin-left: auto;
        }

        .nai-backup-section-controls .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 8px;
            font-size: 10px;
        }

        .nai-backup-item-list {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 5px;
            max-height: 180px;
            overflow-y: auto;
            padding: 8px;
        }

        .nai-backup-item {
            display: flex;
            align-items: center;
            gap: 7px;
            min-width: 0;
            padding: 6px 8px;
            border: 1px solid #333750;
            border-radius: 5px;
            background: #1c1f31;
            color: #cfd2e2;
            cursor: pointer;
            font-size: 11px;
            line-height: 1.3;
        }

        .nai-backup-item:hover {
            border-color: #505574;
            background: #22263a;
        }

        .nai-backup-item input {
            flex: 0 0 auto;
            width: 14px;
            height: 14px;
            margin: 0;
            accent-color: #9773ff;
        }

        .nai-backup-item-label {
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        .nai-backup-empty {
            grid-column: 1 / -1;
            padding: 7px 4px;
            color: #777d99;
            font-size: 11px;
        }

        .nai-restore-preview {
            margin-top: 12px;
            padding: 12px;
            border: 1px solid #454966;
            border-radius: 7px;
            background: #181a2a;
        }

        .nai-restore-preview[hidden] {
            display: none !important;
        }

        .nai-restore-file-name {
            margin-bottom: 8px;
            color: #e1e4f2;
            font-size: 12px;
            font-weight: 700;
            overflow-wrap: anywhere;
        }

        .nai-restore-summary {
            display: flex;
            flex-direction: column;
            gap: 6px;
            margin-top: 10px;
            color: #b7bbcf;
            font-size: 12px;
            line-height: 1.45;
        }

        .nai-restore-summary strong {
            color: #f1f2f7;
        }

        .nai-provider-buttons {
            display: flex;
            gap: 8px;
            margin-bottom: 18px;
        }

        .nai-provider-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            flex: 1 1 0;
            padding: 10px;
            border: 1px solid #3d405c;
            border-radius: 5px;
            background: #181a2a;
            color: #fff;
            cursor: pointer;
            font: inherit;
            font-size: 12px;
            font-weight: 700;
        }

        .nai-provider-button.active {
            border-color: #9773ff;
            background: rgba(151, 115, 255, 0.16);
        }

        .nai-provider-section {
            display: none;
        }

        .nai-provider-section.active {
            display: block;
        }

        .nai-ai-results {
            display: grid;
            gap: 10px;
            margin-top: 12px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        .nai-ai-result-card {
            border: 1px solid #454966;
            border-radius: 7px;
            padding: 13px;
            background: #171927;
            min-height: 0;
            height: auto;
            align-self: start;
        }

        .nai-ai-result-card .nai-loader-textarea {
            min-height: 72px;
            max-height: 260px;
            overflow-y: auto;
        }

        .nai-ai-result-head {
            display: flex;
            gap: 9px;
            align-items: center;
            margin-bottom: 10px;
        }

        .nai-ai-result-head input[type="checkbox"] {
            width: 16px;
            height: 16px;
            accent-color: #9773ff;
            flex: 0 0 auto;
        }

        .nai-ai-result-index {
            font-size: 12px;
            font-weight: 800;
            color: #aeb2cc;
        }

        .nai-ai-extra-options {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 8px;
            margin-left: auto;
        }

        .nai-ai-add-character {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            height: 24px;
            min-height: 24px;
            padding: 0 8px;
            border: 1px solid #454966;
            border-radius: 4px;
            background: #1b1e30;
            color: #d2d5e8;
            font-size: 11px;
            font-weight: 800;
            line-height: 1;
            text-align: center;
            cursor: pointer;
        }

        .nai-ai-add-character:hover:not(:disabled) {
            background: #292d45;
            border-color: #626786;
        }

        .nai-ai-add-character:disabled {
            opacity: 0.4;
            cursor: default;
        }

        .nai-analysis-prompt-editor {
            margin-bottom: 12px;
        }

        .nai-analysis-prompt-tabs {
            display: flex;
            align-items: flex-end;
            gap: 14px;
            min-height: 29px;
            margin-bottom: 8px;
            border-bottom: 1px solid #353850;
        }

        .nai-analysis-prompt-tab {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 29px;
            padding: 0 1px 6px;
            border: 0;
            border-bottom: 2px solid transparent;
            background: transparent;
            color: #8f95b5;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            text-align: center;
            cursor: pointer;
        }

        .nai-analysis-prompt-tab.active {
            color: #f1f2fa;
            border-bottom-color: #8ca5ff;
        }

        .nai-analysis-prompt-panel[hidden] {
            display: none !important;
        }

        .nai-ai-character-title-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
            margin-bottom: 4px;
        }

        .nai-ai-character-remove {
            flex: 0 0 auto;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            width: 24px;
            height: 24px;
            padding: 0;
            border: 0;
            border-radius: 4px;
            background: transparent;
            color: #969cb8;
            font-size: 18px;
            line-height: 1;
            text-align: center;
            cursor: pointer;
        }

        .nai-ai-character-remove:hover {
            background: rgba(255, 255, 255, 0.07);
            color: #f0f1f8;
        }

        .nai-inline-note-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            min-height: 24px;
            padding: 0 2px;
            border: 0;
            background: transparent;
            color: #b8bbcf;
            font-size: 12px;
            font-weight: 700;
            line-height: 1;
            cursor: pointer;
            white-space: nowrap;
        }

        .nai-inline-note-toggle:hover {
            color: #fff;
        }

        .nai-inline-note-body {
            width: 100%;
            margin: 0 0 10px;
        }

        .nai-inline-note-body[hidden] {
            display: none !important;
        }

        .nai-note-details {
            margin: 0 0 10px;
            border: 0;
            background: transparent;
        }

        .nai-note-details > summary {
            min-height: 22px;
            padding: 0;
            cursor: pointer;
            color: #b8bbcf;
            font-size: 12px;
            font-weight: 700;
            line-height: 22px;
            user-select: none;
        }

        .nai-note-details > summary::marker {
            color: #959ab7;
        }

        .nai-note-editor {
            width: 100%;
            margin: 0;
            box-sizing: border-box;
        }

        .nai-character-group {
            display: grid;
            gap: 9px;
            margin-top: 10px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        .nai-character-block {
            padding: 10px;
            border: 1px solid #363a55;
            border-radius: 6px;
            background: #131522;
            min-height: 0 !important;
            height: auto !important;
            align-self: start;
        }

        .nai-character-title {
            margin-bottom: 7px;
            color: #c8cbe0;
            font-size: 12px;
            font-weight: 800;
        }

        .nai-character-subtitle {
            margin: 8px 0 5px;
            color: #959ab7;
            font-size: 11px;
            font-weight: 700;
        }

        .nai-character-block .nai-concept-tags {
            max-height: 130px;
        }

        .nai-ai-character-block {
            margin: 0 0 10px;
            padding: 10px;
            border: 1px solid #363a55;
            border-radius: 6px;
            background: #131522;
        }

        .nai-ai-character-block:last-child {
            margin-bottom: 0;
        }

        .nai-loading {
            display: inline-flex;
            align-items: center;
            gap: 7px;
        }

        .nai-loading::before {
            content: '';
            width: 10px;
            height: 10px;
            border: 2px solid #6e7393;
            border-top-color: #fff;
            border-radius: 50%;
            animation: nai-spin 0.8s linear infinite;
        }

        @keyframes nai-spin {
            to { transform: rotate(360deg); }
        }

        .nai-info-create-card {
            margin-bottom: 14px;
            border: 1px solid #3d405c;
            border-radius: 7px;
            padding: 13px;
            background: #191b2b;
        }

        .nai-info-create-card .nai-loader-textarea,
        .nai-info-edit-card .nai-loader-textarea {
            min-height: 78px;
            max-height: 240px;
        }

        .nai-info-list {
            display: grid;
            gap: 10px;
            align-items: start;
            align-content: start;
            grid-auto-rows: max-content;
        }

        /* 자료실은 링크 카드를 3열로 배치한다. */
        #nai-resource-list {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }

        .nai-info-card {
            border: 1px solid #353850;
            border-radius: 7px;
            background: #191b2b;
            padding: 13px;
        }

        #nai-resource-list .nai-resource-card {
            display: flex;
            padding: 10px 13px 10px 8px;
            flex-direction: column;
            min-width: 0;
            min-height: 120px;
            cursor: pointer;
            transition: border-color 0.14s ease, background 0.14s ease, transform 0.14s ease;
        }

        #nai-resource-list .nai-resource-card:hover,
        #nai-resource-list .nai-resource-card:focus-visible {
            border-color: #555b83;
            background: #1d2032;
            outline: none;
        }

        #nai-resource-list .nai-resource-card:active {
            transform: translateY(1px);
        }

        #nai-resource-list .nai-resource-card .nai-info-card-head {
            margin-bottom: 0;
        }

        .nai-resource-title-group {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
        }

        .nai-resource-title-group .nai-info-card-title {
            flex: 0 1 auto;
        }

        .nai-resource-order-handle,
        .nai-library-order-handle,
        .nai-memo-order-handle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            flex: 0 0 auto;
            width: 22px;
            height: 22px;
            padding: 0;
            border: 0;
            border-radius: 4px;
            background: transparent;
            color: #8f95af;
            cursor: grab;
            touch-action: none;
            user-select: none;
            font: inherit;
            font-size: 15px;
            font-weight: 800;
            line-height: 1;
        }

        .nai-resource-order-handle:hover,
        .nai-library-order-handle:hover,
        .nai-memo-order-handle:hover {
            background: #30344b;
            color: #fff;
        }

        .nai-resource-order-handle:active,
        .nai-resource-order-handle.dragging,
        .nai-library-order-handle:active,
        .nai-library-order-handle.dragging,
        .nai-memo-order-handle:active,
        .nai-memo-order-handle.dragging {
            cursor: grabbing;
            background: #5b46a8;
            color: #fff;
        }

        #nai-resource-list .nai-resource-card.nai-resource-dragging {
            opacity: 0.58;
            border-color: #9773ff;
            background: #24263d;
            transform: scale(0.985);
            cursor: grabbing;
            z-index: 2;
        }

        #nai-resource-list.nai-resource-drag-active .nai-resource-card:not(.nai-resource-dragging) {
            transition: transform 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        #nai-library-list .nai-concept-card.nai-library-dragging {
            opacity: 0.58;
            border-color: #9773ff;
            background: #24263d;
            transform: scale(0.995);
            cursor: grabbing;
            z-index: 2;
        }

        #nai-library-list.nai-library-drag-active .nai-concept-card:not(.nai-library-dragging) {
            transition: transform 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        /* 메모는 본문을 항상 보여주되 자료실처럼 촘촘한 드래그 카드로 정리한다. */
        #nai-memo-list .nai-memo-card {
            display: flex;
            flex-direction: column;
            min-width: 0;
            padding: 10px 13px 10px 8px;
        }

        #nai-memo-list .nai-memo-card .nai-info-card-head {
            margin-bottom: 0;
        }

        .nai-memo-title-group {
            display: flex;
            align-items: center;
            gap: 6px;
            min-width: 0;
            max-width: 100%;
        }

        .nai-memo-title-group .nai-info-card-title {
            flex: 0 1 auto;
        }

        #nai-memo-list .nai-memo-card.nai-memo-dragging {
            opacity: 0.58;
            border-color: #9773ff;
            background: #24263d;
            transform: scale(0.995);
            cursor: grabbing;
            z-index: 2;
        }

        #nai-memo-list.nai-memo-drag-active .nai-memo-card:not(.nai-memo-dragging) {
            transition: transform 0.1s ease, border-color 0.1s ease, background 0.1s ease;
        }

        .nai-memo-category-badges {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            margin-top: 8px;
            pointer-events: none;
        }

        .nai-memo-category-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 20px;
            padding: 0 7px;
            border: 1px solid #9773ff;
            border-radius: 4px;
            background: #5b46a8;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            line-height: 1;
            white-space: nowrap;
        }

        #nai-memo-list .nai-memo-card .nai-info-note {
            margin-top: 9px;
        }

        #nai-memo-list .nai-memo-card .nai-info-actions {
            margin-top: 10px;
        }

        /* 보기 카드에서는 선택된 분류만 표시하며 직접 수정하지 않는다. */
        .nai-resource-category-badges {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            gap: 5px;
            margin-top: 8px;
            pointer-events: none;
        }

        .nai-resource-category-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-height: 20px;
            padding: 0 7px;
            border: 1px solid #9773ff;
            border-radius: 4px;
            background: #5b46a8;
            color: #fff;
            font-size: 10px;
            font-weight: 700;
            line-height: 1;
            white-space: nowrap;
        }

        #nai-resource-list .nai-resource-card .nai-info-note {
            display: -webkit-box;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 4;
            overflow: hidden;
            margin-top: 9px;
        }

        /* 삭제/수정 구간은 링크 카드 클릭 대상에서 분리한다. */
        #nai-resource-list .nai-resource-card .nai-info-actions {
            cursor: default;
        }

        #nai-resource-list .nai-resource-card .nai-info-actions {
            margin-top: auto;
            padding-top: 12px;
        }

        #nai-resource-list .nai-info-edit-card {
            grid-column: 1 / -1;
            cursor: default;
        }

        .nai-info-card-head {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
            margin-bottom: 7px;
        }

        .nai-info-card-title {
            min-width: 0;
            flex: 1 1 auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            color: #eef0f8;
            font-size: 13px;
            font-weight: 800;
        }

        .nai-info-note {
            margin-top: 7px;
            color: #c9ccdc;
            font-size: 12px;
            line-height: 1.6;
            white-space: pre-wrap;
            word-break: break-word;
        }

        .nai-info-actions {
            width: 100%;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
        }

        .nai-info-action-right {
            margin-left: auto;
            display: flex;
            align-items: center;
            justify-content: flex-end;
            flex-wrap: wrap;
            gap: 7px;
        }

        .nai-info-actions .nai-loader-action {
            height: 22px;
            min-height: 22px;
            padding: 0 9px;
            border-radius: 4px;
            font-size: 11px;
        }

        @media (max-width: 860px) {
            #nai-resource-list {
                grid-template-columns: repeat(2, minmax(0, 1fr));
            }
        }

        @media (max-width: 620px) {
            #nai-resource-list {
                grid-template-columns: minmax(0, 1fr);
            }

            .nai-backup-item-list {
                grid-template-columns: minmax(0, 1fr);
            }

            .nai-loader-row {
                flex-direction: column;
                align-items: stretch;
            }

            .nai-provider-buttons {
                flex-direction: row;
                align-items: stretch;
                gap: 8px;
            }

            .nai-provider-button {
                flex: 1 1 0;
                min-width: 0;
                padding: 10px 6px;
                font-size: 11px;
            }

            .nai-library-toolbar,
            .nai-import-action-row,
            .nai-settings-action-row {
                flex-direction: row;
                align-items: stretch;
            }

            .nai-import-action-row {
                gap: 8px;
            }

            .nai-import-action-row .nai-loader-action {
                flex: 1 1 0;
                min-width: 0;
                height: 28px;
                min-height: 28px;
                padding: 0 7px;
                font-size: 11px;
            }

            .nai-settings-action-row {
                justify-content: flex-end;
                gap: 8px;
            }

            .nai-settings-action-row .nai-loader-action {
                flex: 0 0 auto;
            }

            .nai-analysis-header-row {
                flex-direction: row;
                align-items: stretch;
                flex-wrap: wrap;
                gap: 8px;
            }

            .nai-analysis-header-row .nai-loader-section-title {
                flex: 0 0 100%;
                width: 100%;
            }

            .nai-analysis-header-row .nai-loader-action {
                flex: 1 1 0;
                min-width: 0;
                height: 28px;
                min-height: 28px;
                padding: 0 6px;
                font-size: 11px;
            }
        }
    `);

    function simpleHash(value) {
        let hash = 2166136261;
        const s = String(value || '');
        for (let i = 0; i < s.length; i++) {
            hash ^= s.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function getSettings() {
        const saved = GM_getValue(SETTINGS_KEY, {});
        const merged = { ...DEFAULT_SETTINGS, ...(saved || {}) };

        merged.geminiModel = merged.geminiModel || DEFAULT_MODEL;
        merged.vertexModel = merged.vertexModel || DEFAULT_MODEL;
        merged.firebaseModel = merged.firebaseModel || DEFAULT_MODEL;
        merged.firebaseBackend = merged.firebaseBackend || 'vertex';

        return merged;
    }

    function saveSettings(settings) {
        GM_setValue(SETTINGS_KEY, {
            ...DEFAULT_SETTINGS,
            ...(settings || {})
        });
    }

    function normalizeCharacterRows(rows) {
        if (!Array.isArray(rows)) return [];

        return rows
            .map((row, index) => {
                const prompt = String(
                    row?.prompt ??
                    row?.tags ??
                    row?.positivePrompt ??
                    ''
                ).trim();

                const negativePrompt = String(
                    row?.negativePrompt ??
                    row?.negativeTags ??
                    row?.undesiredContent ??
                    ''
                ).trim();

                const isDraft = !!row?._analysisDraft;
                if (!prompt && !negativePrompt && !isDraft) return null;

                return {
                    name:
                        String(row?.name || row?.label || '').trim() ||
                        `Character ${index + 1}`,
                    prompt,
                    negativePrompt,
                    ...(isDraft ? { _analysisDraft: true } : {})
                };
            })
            .filter(Boolean);
    }

    function normalizeLibraryCategoryName(value) {
        return String(value || '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 30);
    }

    function normalizeLibraryCategoryList(values) {
        const seen = new Set();
        return (Array.isArray(values) ? values : [])
            .map(normalizeLibraryCategoryName)
            .filter(name => {
                if (!name || name === '전체' || name === '+' || seen.has(name)) return false;
                seen.add(name);
                return true;
            });
    }

    function getLibraryCategories() {
        const saved = normalizeLibraryCategoryList(
            GM_getValue(LIBRARY_CATEGORY_KEY, [])
        );

        const fromItems = getLibrary()
            .flatMap(item => Array.isArray(item.categories) ? item.categories : []);

        return normalizeLibraryCategoryList([...saved, ...fromItems]);
    }

    function saveLibraryCategories(categories) {
        GM_setValue(
            LIBRARY_CATEGORY_KEY,
            normalizeLibraryCategoryList(categories)
        );
    }

    function normalizeConceptRecord(item) {
        const tags = String(
            item?.tags ??
            item?.basePrompt ??
            item?.prompt ??
            ''
        ).trim();

        const negativeTags = String(
            item?.negativeTags ??
            item?.negativePrompt ??
            item?.undesiredContent ??
            ''
        ).trim();

        const characters = normalizeCharacterRows(item?.characters);
        const {
            includeNegativeTags: _legacyIncludeNegativeTags,
            includeCharacterNegative: _legacyIncludeCharacterNegative,
            ...rest
        } = item || {};

        return {
            ...rest,
            tags,
            negativeTags,
            characters,
            note: String(item?.note || '').trim(),
            categories: normalizeLibraryCategoryList(item?.categories)
        };
    }

    function getLibrary() {
        const saved = GM_getValue(LIBRARY_KEY, []);
        return Array.isArray(saved)
            ? saved.map(normalizeConceptRecord)
            : [];
    }

    function saveLibrary(library) {
        GM_setValue(
            LIBRARY_KEY,
            Array.isArray(library)
                ? library.map(normalizeConceptRecord)
                : []
        );
    }

    function normalizeResourceRecord(item) {
        return {
            id: String(item?.id || createId()),
            name: String(item?.name || '').trim(),
            url: String(item?.url || '').trim(),
            note: String(item?.note || '').trim(),
            categories: normalizeLibraryCategoryList(item?.categories),
            createdAt: Number(item?.createdAt || Date.now()),
            updatedAt: Number(item?.updatedAt || item?.createdAt || Date.now())
        };
    }

    function getResources() {
        const saved = GM_getValue(RESOURCE_KEY, []);
        return Array.isArray(saved)
            ? saved.map(normalizeResourceRecord)
            : [];
    }

    function saveResources(resources) {
        GM_setValue(
            RESOURCE_KEY,
            Array.isArray(resources)
                ? resources.map(normalizeResourceRecord)
                : []
        );
    }

    function getResourceCategories() {
        const saved = normalizeLibraryCategoryList(
            GM_getValue(RESOURCE_CATEGORY_KEY, [])
        );
        const fromItems = getResources()
            .flatMap(item => Array.isArray(item.categories) ? item.categories : []);
        return normalizeLibraryCategoryList([...saved, ...fromItems]);
    }

    function saveResourceCategories(categories) {
        GM_setValue(
            RESOURCE_CATEGORY_KEY,
            normalizeLibraryCategoryList(categories)
        );
    }

    function normalizeMemoRecord(item) {
        return {
            id: String(item?.id || createId()),
            title: String(item?.title || '').trim(),
            content: String(item?.content || '').trim(),
            categories: normalizeLibraryCategoryList(item?.categories),
            createdAt: Number(item?.createdAt || Date.now()),
            updatedAt: Number(item?.updatedAt || item?.createdAt || Date.now())
        };
    }

    function getMemos() {
        const saved = GM_getValue(MEMO_KEY, []);
        return Array.isArray(saved)
            ? saved.map(normalizeMemoRecord)
            : [];
    }

    function saveMemos(memos) {
        GM_setValue(
            MEMO_KEY,
            Array.isArray(memos)
                ? memos.map(normalizeMemoRecord)
                : []
        );
    }

    function exactStoredText(value) {
        return String(value || '').trim();
    }

    function conceptExactContentKey(item) {
        const normalized = normalizeConceptRecord(item);
        const characters = normalizeCharacterRows(normalized.characters)
            .map(character => ({
                prompt: exactStoredText(character.prompt),
                negativePrompt: exactStoredText(character.negativePrompt)
            }))
            .filter(character => character.prompt || character.negativePrompt);

        return JSON.stringify({
            tags: exactStoredText(normalized.tags),
            negativeTags: exactStoredText(normalized.negativeTags),
            characters
        });
    }

    function findLibraryExactDuplicate(item) {
        const key = conceptExactContentKey(item);
        return getLibrary().find(saved => conceptExactContentKey(saved) === key) || null;
    }

    function findResourceExactDuplicate(url) {
        const normalizedUrl = normalizedExternalUrl(url);
        if (!normalizedUrl) return null;
        return getResources().find(item => normalizedExternalUrl(item.url) === normalizedUrl) || null;
    }

    function findMemoExactDuplicate(content) {
        const normalizedContent = exactStoredText(content);
        if (!normalizedContent) return null;
        return getMemos().find(item => exactStoredText(item.content) === normalizedContent) || null;
    }

    function getMemoCategories() {
        const saved = normalizeLibraryCategoryList(
            GM_getValue(MEMO_CATEGORY_KEY, [])
        );
        const fromItems = getMemos()
            .flatMap(item => Array.isArray(item.categories) ? item.categories : []);
        return normalizeLibraryCategoryList([...saved, ...fromItems]);
    }

    function saveMemoCategories(categories) {
        GM_setValue(
            MEMO_CATEGORY_KEY,
            normalizeLibraryCategoryList(categories)
        );
    }

    const ARCHIVE_BACKUP_FORMAT = 'NAI_ARCHIVE_BACKUP';
    const ARCHIVE_BACKUP_VERSION = 1;

    function backupConceptRecord(item) {
        const normalized = normalizeConceptRecord(item);
        const source = normalized?.source && typeof normalized.source === 'object'
            ? normalized.source
            : {};

        return {
            name: String(normalized.name || normalized.suggestedName || '').trim(),
            tags: String(normalized.tags || '').trim(),
            negativeTags: String(normalized.negativeTags || '').trim(),
            characters: normalizeCharacterRows(normalized.characters).map(character => ({
                name: String(character.name || '').trim(),
                prompt: String(character.prompt || '').trim(),
                negativePrompt: String(character.negativePrompt || '').trim()
            })),
            note: String(normalized.note || '').trim(),
            categories: normalizeLibraryCategoryList(normalized.categories),
            source: {
                type: String(source.type || '').trim(),
                url: String(source.url || normalized.sourceUrl || '').trim(),
                rootUrl: String(source.rootUrl || '').trim(),
                provider: String(source.provider || '').trim(),
                importMethod: String(source.importMethod || '').trim(),
                pageTitle: String(source.pageTitle || '').trim()
            },
            createdAt: Number(normalized.createdAt || Date.now()),
            updatedAt: Number(normalized.updatedAt || normalized.createdAt || Date.now())
        };
    }

    function categoriesUsedByBackupItems(items, orderedCategories) {
        const used = new Set(
            (Array.isArray(items) ? items : [])
                .flatMap(item => normalizeLibraryCategoryList(item?.categories))
        );
        const ordered = normalizeLibraryCategoryList(orderedCategories)
            .filter(category => used.has(category));
        const extras = [...used].filter(category => !ordered.includes(category));
        return normalizeLibraryCategoryList([...ordered, ...extras]);
    }

    function createArchiveBackupPayload(selection) {
        const sections = {};
        const selectedIds = selection && !Array.isArray(selection) && typeof selection === 'object'
            ? selection
            : null;
        const legacyKinds = new Set(Array.isArray(selection) ? selection : []);

        const resolveSelected = (kind, items) => {
            if (!selectedIds) {
                return legacyKinds.has(kind) ? items : [];
            }
            const raw = selectedIds[kind];
            const ids = raw instanceof Set
                ? raw
                : new Set(Array.isArray(raw) ? raw.map(String) : []);
            return items.filter(item => ids.has(String(item?.id || '')));
        };

        const libraryItems = resolveSelected('library', getLibrary());
        if (libraryItems.length) {
            sections.library = {
                categories: categoriesUsedByBackupItems(libraryItems, getLibraryCategories()),
                items: libraryItems.map(backupConceptRecord)
            };
        }

        const resourceItems = resolveSelected('resources', getResources());
        if (resourceItems.length) {
            sections.resources = {
                categories: categoriesUsedByBackupItems(resourceItems, getResourceCategories()),
                items: resourceItems.map(item => ({
                    name: String(item.name || '').trim(),
                    url: String(item.url || '').trim(),
                    note: String(item.note || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    createdAt: Number(item.createdAt || Date.now()),
                    updatedAt: Number(item.updatedAt || item.createdAt || Date.now())
                }))
            };
        }

        const memoItems = resolveSelected('memos', getMemos());
        if (memoItems.length) {
            sections.memos = {
                categories: categoriesUsedByBackupItems(memoItems, getMemoCategories()),
                items: memoItems.map(item => ({
                    title: String(item.title || '').trim(),
                    content: String(item.content || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    createdAt: Number(item.createdAt || Date.now()),
                    updatedAt: Number(item.updatedAt || item.createdAt || Date.now())
                }))
            };
        }

        return {
            format: ARCHIVE_BACKUP_FORMAT,
            version: ARCHIVE_BACKUP_VERSION,
            app: APP_NAME,
            appVersion: APP_VERSION,
            exportedAt: new Date().toISOString(),
            sections
        };
    }

    function parseArchiveBackupPayload(rawText) {
        let parsed;
        try {
            parsed = JSON.parse(String(rawText || ''));
        } catch (_) {
            throw new Error('JSON 백업 파일을 읽을 수 없습니다.');
        }

        if (!parsed || parsed.format !== ARCHIVE_BACKUP_FORMAT) {
            throw new Error('NAI Archive 백업 파일이 아닙니다.');
        }

        if (Number(parsed.version) !== ARCHIVE_BACKUP_VERSION) {
            throw new Error(`지원하지 않는 백업 형식 버전입니다: ${parsed.version ?? '알 수 없음'}`);
        }

        const rawSections = parsed.sections && typeof parsed.sections === 'object'
            ? parsed.sections
            : {};
        const sections = {};

        if (rawSections.library && Array.isArray(rawSections.library.items)) {
            sections.library = {
                categories: normalizeLibraryCategoryList(rawSections.library.categories),
                items: rawSections.library.items.map(backupConceptRecord)
            };
        }

        if (rawSections.resources && Array.isArray(rawSections.resources.items)) {
            sections.resources = {
                categories: normalizeLibraryCategoryList(rawSections.resources.categories),
                items: rawSections.resources.items.map(normalizeResourceRecord)
            };
        }

        if (rawSections.memos && Array.isArray(rawSections.memos.items)) {
            sections.memos = {
                categories: normalizeLibraryCategoryList(rawSections.memos.categories),
                items: rawSections.memos.items.map(normalizeMemoRecord)
            };
        }

        if (!Object.keys(sections).length) {
            throw new Error('복원할 라이브러리/자료실/메모 데이터가 없습니다.');
        }

        return {
            format: ARCHIVE_BACKUP_FORMAT,
            version: ARCHIVE_BACKUP_VERSION,
            appVersion: String(parsed.appVersion || ''),
            exportedAt: String(parsed.exportedAt || ''),
            sections
        };
    }

    function inspectArchiveRestore(backup) {
        const result = {};

        if (backup?.sections?.library) {
            const seen = new Set(getLibrary().map(conceptExactContentKey));
            let duplicate = 0;
            let addable = 0;
            for (const item of backup.sections.library.items) {
                const key = conceptExactContentKey(item);
                if (seen.has(key)) duplicate += 1;
                else {
                    seen.add(key);
                    addable += 1;
                }
            }
            result.library = {
                total: backup.sections.library.items.length,
                duplicate,
                addable,
                invalid: 0
            };
        }

        if (backup?.sections?.resources) {
            const seen = new Set(
                getResources()
                    .map(item => normalizedExternalUrl(item.url))
                    .filter(Boolean)
            );
            let duplicate = 0;
            let addable = 0;
            let invalid = 0;
            for (const item of backup.sections.resources.items) {
                const key = normalizedExternalUrl(item.url);
                if (!key) invalid += 1;
                else if (seen.has(key)) duplicate += 1;
                else {
                    seen.add(key);
                    addable += 1;
                }
            }
            result.resources = {
                total: backup.sections.resources.items.length,
                duplicate,
                addable,
                invalid
            };
        }

        if (backup?.sections?.memos) {
            const seen = new Set(
                getMemos()
                    .map(item => exactStoredText(item.content))
                    .filter(Boolean)
            );
            let duplicate = 0;
            let addable = 0;
            let invalid = 0;
            for (const item of backup.sections.memos.items) {
                const key = exactStoredText(item.content);
                if (!key) invalid += 1;
                else if (seen.has(key)) duplicate += 1;
                else {
                    seen.add(key);
                    addable += 1;
                }
            }
            result.memos = {
                total: backup.sections.memos.items.length,
                duplicate,
                addable,
                invalid
            };
        }

        return result;
    }

    function restoreArchiveBackup(backup, kinds) {
        const selected = new Set(Array.isArray(kinds) ? kinds : []);
        const result = {
            library: { added: 0, duplicate: 0, invalid: 0 },
            resources: { added: 0, duplicate: 0, invalid: 0 },
            memos: { added: 0, duplicate: 0, invalid: 0 }
        };
        const now = Date.now();

        if (selected.has('library') && backup?.sections?.library) {
            const current = getLibrary();
            const seen = new Set(current.map(conceptExactContentKey));
            const added = [];

            for (const rawItem of backup.sections.library.items) {
                const item = backupConceptRecord(rawItem);
                const key = conceptExactContentKey(item);
                if (seen.has(key)) {
                    result.library.duplicate += 1;
                    continue;
                }
                seen.add(key);
                const source = item.source && typeof item.source === 'object' ? item.source : {};
                added.push({
                    id: createId(),
                    name: String(item.name || '').trim() || '복원한 컨셉',
                    tags: String(item.tags || '').trim(),
                    negativeTags: String(item.negativeTags || '').trim(),
                    characters: normalizeCharacterRows(item.characters),
                    note: String(item.note || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    source: {
                        type: String(source.type || '').trim(),
                        url: String(source.url || '').trim(),
                        rootUrl: String(source.rootUrl || '').trim(),
                        provider: String(source.provider || '').trim(),
                        importMethod: String(source.importMethod || '').trim(),
                        pageTitle: String(source.pageTitle || '').trim()
                    },
                    createdAt: Number(item.createdAt || now),
                    updatedAt: now
                });
            }

            if (added.length) saveLibrary([...current, ...added]);
            saveLibraryCategories(normalizeLibraryCategoryList([
                ...getLibraryCategories(),
                ...backup.sections.library.categories,
                ...added.flatMap(item => item.categories)
            ]));
            result.library.added = added.length;
        }

        if (selected.has('resources') && backup?.sections?.resources) {
            const current = getResources();
            const seen = new Set(current.map(item => normalizedExternalUrl(item.url)).filter(Boolean));
            const added = [];

            for (const rawItem of backup.sections.resources.items) {
                const item = normalizeResourceRecord(rawItem);
                const key = normalizedExternalUrl(item.url);
                if (!key) {
                    result.resources.invalid += 1;
                    continue;
                }
                if (seen.has(key)) {
                    result.resources.duplicate += 1;
                    continue;
                }
                seen.add(key);
                added.push({
                    ...item,
                    id: createId(),
                    url: key,
                    createdAt: Number(item.createdAt || now),
                    updatedAt: now
                });
            }

            if (added.length) saveResources([...current, ...added]);
            saveResourceCategories(normalizeLibraryCategoryList([
                ...getResourceCategories(),
                ...backup.sections.resources.categories,
                ...added.flatMap(item => item.categories)
            ]));
            result.resources.added = added.length;
        }

        if (selected.has('memos') && backup?.sections?.memos) {
            const current = getMemos();
            const seen = new Set(current.map(item => exactStoredText(item.content)).filter(Boolean));
            const added = [];

            for (const rawItem of backup.sections.memos.items) {
                const item = normalizeMemoRecord(rawItem);
                const key = exactStoredText(item.content);
                if (!key) {
                    result.memos.invalid += 1;
                    continue;
                }
                if (seen.has(key)) {
                    result.memos.duplicate += 1;
                    continue;
                }
                seen.add(key);
                added.push({
                    ...item,
                    id: createId(),
                    content: key,
                    createdAt: Number(item.createdAt || now),
                    updatedAt: now
                });
            }

            if (added.length) saveMemos([...current, ...added]);
            saveMemoCategories(normalizeLibraryCategoryList([
                ...getMemoCategories(),
                ...backup.sections.memos.categories,
                ...added.flatMap(item => item.categories)
            ]));
            result.memos.added = added.length;
        }

        return result;
    }

    function normalizedExternalUrl(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        try {
            const url = new URL(raw);
            if (!/^https?:$/i.test(url.protocol)) return '';
            return url.href;
        } catch (_) {
            return '';
        }
    }

    function fallbackResourceName(url) {
        try {
            return new URL(url).hostname.replace(/^www\./i, '') || '자료';
        } catch (_) {
            return '자료';
        }
    }

    function createId() {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }

        return `nai-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function notionExternalAccessMode(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return host === 'app.notion.com' ? 'guest' : 'public';
        } catch (_) {
            return 'public';
        }
    }

    function detectSourceType(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();

            if (
                host === 'app.notion.com' ||
                host.endsWith('notion.site') ||
                host.includes('notion.so')
            ) {
                return 'Notion';
            }

            if (host.includes('dcinside.com')) {
                return 'DCInside';
            }

            return host || 'Web';
        } catch (_) {
            return 'Unknown';
        }
    }

    function isNotionUrl(url) {
        try {
            const host = new URL(url).hostname.toLowerCase();
            return (
                host === 'app.notion.com' ||
                host === 'notion.so' ||
                host.endsWith('.notion.so') ||
                host === 'notion.site' ||
                host.endsWith('.notion.site')
            );
        } catch (_) {
            return false;
        }
    }

    function notionPageKey(url) {
        try {
            const parsed = new URL(url);
            const haystack = `${parsed.pathname}${parsed.search}`;
            const compact = haystack.match(/([0-9a-f]{32})(?:[^0-9a-f]|$)/i);

            if (compact) {
                return compact[1].toLowerCase();
            }

            const dashed = haystack.match(
                /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
            );

            if (dashed) {
                return dashed[1].replace(/-/g, '').toLowerCase();
            }

            parsed.hash = '';
            parsed.search = '';
            parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
            return parsed.toString().toLowerCase();
        } catch (_) {
            return String(url || '').trim().toLowerCase();
        }
    }

    function cleanDiscoveredUrl(candidate, baseUrl) {
        let value = String(candidate || '').trim();

        if (!value) return '';

        value = value
            .replace(/&amp;/g, '&')
            .replace(/\\u0026/g, '&')
            .replace(/\\\//g, '/')
            .replace(/^['\"]+|['\"]+$/g, '');

        try {
            const parsed = new URL(value, baseUrl);

            if (!/^https?:$/.test(parsed.protocol)) return '';

            parsed.hash = '';

            for (const key of [...parsed.searchParams.keys()]) {
                if (
                    /^utm_/i.test(key) ||
                    ['source', 'share', 'duplicate'].includes(key.toLowerCase())
                ) {
                    parsed.searchParams.delete(key);
                }
            }

            return parsed.toString();
        } catch (_) {
            return '';
        }
    }

    function isLikelyAssetUrl(url) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname.toLowerCase();
            return /\.(?:txt|md|markdown|csv|json|pdf)(?:$|\?)/i.test(path);
        } catch (_) {
            return false;
        }
    }

    function isLikelyNotionChildPage(url, rootUrl) {
        try {
            const parsed = new URL(url);
            const root = new URL(rootUrl);
            const host = parsed.hostname.toLowerCase();
            const rootHost = root.hostname.toLowerCase();

            if (!/^https?:$/.test(parsed.protocol)) return false;
            if (isLikelyAssetUrl(parsed.toString())) return false;

            const notionHost =
                host === 'app.notion.com' ||
                host === 'notion.so' ||
                host.endsWith('.notion.so') ||
                host === 'notion.site' ||
                host.endsWith('.notion.site');

            if (!notionHost) return false;

            if (host !== rootHost && !host.endsWith('.notion.so')) {
                return false;
            }

            const path = parsed.pathname.toLowerCase();
            const blocked = [
                '/login', '/signup', '/help', '/templates', '/product',
                '/pricing', '/download', '/desktop', '/front-static',
                '/api/', '/_next/', '/images/', '/assets/', '/fonts/'
            ];

            if (blocked.some(prefix => path.startsWith(prefix))) return false;

            if (host !== rootHost) {
                const hasPageId =
                    /[0-9a-f]{32}(?:[^0-9a-f]|$)/i.test(path) ||
                    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(path);

                if (!hasPageId) return false;
            }

            return true;
        } catch (_) {
            return false;
        }
    }

    function normalizeUrl(url) {
        const value = String(url || '').trim();
        const parsed = new URL(value);

        if (!/^https?:$/.test(parsed.protocol)) {
            throw new Error('http:// 또는 https:// URL만 사용할 수 있습니다.');
        }

        return parsed.toString();
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(String(text || ''));
            return true;
        } catch (_) {
            try {
                const ta = document.createElement('textarea');
                ta.value = String(text || '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                ta.remove();
                return true;
            } catch (_) {
                return false;
            }
        }
    }

    function encodeShareCodeText(text) {
        const bytes = new TextEncoder().encode(String(text || ''));
        let binary = '';
        const chunkSize = 0x8000;

        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }

        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    function decodeShareCodeText(encoded) {
        const normalized = String(encoded || '')
            .trim()
            .replace(/\s+/g, '')
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }

        return new TextDecoder().decode(bytes);
    }

    function createConceptShareCode(rawItem) {
        const item = normalizeConceptRecord(rawItem);
        const payload = {
            v: 1,
            kind: 'concept',
            name: String(item.name || '').trim(),
            tags: String(item.tags || '').trim(),
            negativeTags: String(item.negativeTags || '').trim(),
            characters: normalizeCharacterRows(item.characters).map(character => ({
                name: String(character.name || '').trim(),
                prompt: String(character.prompt || '').trim(),
                negativePrompt: String(character.negativePrompt || '').trim()
            })),
            note: String(item.note || '').trim(),
            sourceUrl: normalizedExternalUrl(item?.source?.url || '')
        };

        return SHARE_CODE_PREFIX + encodeShareCodeText(JSON.stringify(payload));
    }

    function createResourceShareCode(rawItem) {
        const item = normalizeResourceRecord(rawItem);
        const url = normalizedExternalUrl(item.url || '');
        if (!url) throw new Error('공유할 자료의 링크가 올바르지 않습니다.');

        const payload = {
            v: 1,
            kind: 'resource',
            name: String(item.name || '').trim(),
            url,
            note: String(item.note || '').trim()
        };

        return SHARE_CODE_PREFIX + encodeShareCodeText(JSON.stringify(payload));
    }

    function createMemoShareCode(rawItem) {
        const item = normalizeMemoRecord(rawItem);
        const content = String(item.content || '').trim();
        if (!content) throw new Error('공유할 메모 내용이 없습니다.');

        const payload = {
            v: 1,
            kind: 'memo',
            title: String(item.title || '').trim(),
            content
        };

        return SHARE_CODE_PREFIX + encodeShareCodeText(JSON.stringify(payload));
    }

    function parseShareCodePayload(value) {
        const raw = String(value || '').trim();
        if (!raw.startsWith(SHARE_CODE_PREFIX)) {
            throw new Error(`공유 코드는 ${SHARE_CODE_PREFIX} 로 시작해야 합니다.`);
        }

        let payload;
        try {
            payload = JSON.parse(
                decodeShareCodeText(raw.slice(SHARE_CODE_PREFIX.length))
            );
        } catch (_) {
            throw new Error('공유 코드를 읽을 수 없습니다. 코드가 잘렸거나 손상된 것 같습니다.');
        }

        if (
            payload?.v !== 1 ||
            !['concept', 'resource', 'memo'].includes(payload?.kind)
        ) {
            throw new Error('지원하지 않는 공유 코드 형식입니다.');
        }

        return payload;
    }

    function parseConceptShareCode(value) {
        const payload = parseShareCodePayload(value);
        if (payload.kind !== 'concept') {
            throw new Error('컨셉 공유 코드가 아닙니다.');
        }

        const concept = {
            suggestedName: String(payload.name || '').trim(),
            tags: String(payload.tags || '').trim(),
            negativeTags: String(payload.negativeTags || '').trim(),
            characters: normalizeCharacterRows(payload.characters),
            note: String(payload.note || '').trim(),
            sourceUrl: normalizedExternalUrl(payload.sourceUrl || ''),
            sourcePageTitle: ''
        };

        const hasCharacterContent = concept.characters.some(character =>
            !!String(character.prompt || '').trim() ||
            !!String(character.negativePrompt || '').trim()
        );

        if (!concept.suggestedName) {
            throw new Error('공유 코드에 컨셉 이름이 없습니다.');
        }

        if (!concept.tags && !concept.negativeTags && !hasCharacterContent) {
            throw new Error('공유 코드에 저장할 Prompt 내용이 없습니다.');
        }

        return concept;
    }

    function parseResourceShareCode(value) {
        const payload = parseShareCodePayload(value);
        if (payload.kind !== 'resource') {
            throw new Error('자료실 공유 코드가 아닙니다.');
        }

        const url = normalizedExternalUrl(payload.url || '');
        if (!url) throw new Error('공유 코드의 자료 링크가 올바르지 않습니다.');

        return {
            name: String(payload.name || '').trim() || fallbackResourceName(url),
            url,
            note: String(payload.note || '').trim()
        };
    }

    function parseMemoShareCode(value) {
        const payload = parseShareCodePayload(value);
        if (payload.kind !== 'memo') {
            throw new Error('메모 공유 코드가 아닙니다.');
        }

        const content = String(payload.content || '').trim();
        if (!content) throw new Error('공유 코드에 메모 내용이 없습니다.');

        return {
            title: String(payload.title || '').trim(),
            content
        };
    }


    function isVisiblePromptEditor(editor) {
        if (!editor || !editor.isConnected) return false;

        let node = editor;
        while (node && node.nodeType === 1) {
            const style = PAGE_WINDOW.getComputedStyle
                ? PAGE_WINDOW.getComputedStyle(node)
                : getComputedStyle(node);

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
            ) {
                return false;
            }

            if (node.getAttribute?.('aria-hidden') === 'true') {
                return false;
            }

            node = node.parentElement;
        }

        const rect = editor.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    function pickVisibleElement(nodes) {
        const list = [...(nodes || [])].filter(Boolean);
        return list.find(isVisiblePromptEditor) || list.find(node => node.isConnected) || null;
    }

    function getPromptDocuments() {
        const docs = [document];
        try {
            if (PAGE_WINDOW.document && PAGE_WINDOW.document !== document) {
                docs.push(PAGE_WINDOW.document);
            }
        } catch (_) {}
        return docs;
    }

    function uniqueElements(nodes) {
        return [...new Set([...(nodes || [])].filter(Boolean))];
    }

    function isMainPromptInputBox(box, kind) {
        if (!box || !box.isConnected) return false;
        if (box.closest('.character-prompt-input')) return false;

        const className = String(box.className || '').toLowerCase();
        const isNegative =
            className.includes('undesired-content') ||
            className.includes('negative');

        if (kind === 'negative') return isNegative;
        return !isNegative;
    }

    function getActiveMainPromptRoot() {
        const roots = uniqueElements(
            getPromptDocuments().flatMap(doc =>
                [...doc.querySelectorAll('.image-gen-prompt-main')]
            )
        );
        if (!roots.length) return null;

        const withVisibleEditor = roots.find(root =>
            [...root.querySelectorAll('[data-prompt-input="true"] .ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"]')]
                .some(isVisiblePromptEditor)
        );

        if (withVisibleEditor) return withVisibleEditor;

        const visibleRoot = roots.find(root => {
            if (!root.isConnected) return false;
            const style = PAGE_WINDOW.getComputedStyle
                ? PAGE_WINDOW.getComputedStyle(root)
                : getComputedStyle(root);
            const rect = root.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
        });

        return visibleRoot || roots[roots.length - 1] || null;
    }

    function waitMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function collectMainPromptEditors(kind) {
        const candidates = [];
        const roots = uniqueElements([
            getActiveMainPromptRoot(),
            ...getPromptDocuments().flatMap(doc =>
                [...doc.querySelectorAll('.image-gen-prompt-main')]
            )
        ]);

        const addEditor = editor => {
            if (!editor || !editor.isConnected) return;
            if (editor.closest('.character-prompt-input')) return;
            if (!editor.matches('.ProseMirror[contenteditable="true"]')) return;

            const inputBox = editor.closest('[data-prompt-input="true"], [class*="prompt-input-box-"]');
            if (inputBox && !isMainPromptInputBox(inputBox, kind)) return;

            const cls = String(inputBox?.className || '').toLowerCase();
            if (!inputBox) {
                const neighborhood = String(editor.parentElement?.parentElement?.className || '').toLowerCase();
                const looksNegative = cls.includes('undesired') || neighborhood.includes('undesired');
                if ((kind === 'negative') !== looksNegative) return;
            }

            candidates.push(editor);
        };

        const preferredSelectors = kind === 'negative'
            ? [
                '.prompt-input-box-undesired-content .ProseMirror[contenteditable="true"]',
                '[data-prompt-input="true"][class*="undesired"] .ProseMirror[contenteditable="true"]'
            ]
            : [
                '.prompt-input-box-prompt .ProseMirror[contenteditable="true"]',
                '[data-prompt-input="true"] .ProseMirror[contenteditable="true"]'
            ];

        for (const root of roots) {
            for (const selector of preferredSelectors) {
                root.querySelectorAll(selector).forEach(addEditor);
            }
        }

        for (const doc of getPromptDocuments()) {
            for (const selector of preferredSelectors) {
                doc.querySelectorAll(selector).forEach(addEditor);
            }

            doc.querySelectorAll('[data-prompt-input="true"] .ProseMirror[contenteditable="true"]')
                .forEach(addEditor);
        }

        return uniqueElements(candidates);
    }

    function findMainPromptEditor(kind) {
        return pickVisibleElement(collectMainPromptEditors(kind));
    }

    function findMainPromptButton(kind) {
        const label = kind === 'negative' ? 'Undesired Content' : 'Prompt';
        const candidates = [];
        const roots = uniqueElements([
            getActiveMainPromptRoot(),
            ...getPromptDocuments().flatMap(doc =>
                [...doc.querySelectorAll('.image-gen-prompt-main')]
            )
        ]);

        const addButtons = scope => {
            if (!scope?.querySelectorAll) return;
            for (const button of scope.querySelectorAll('button')) {
                if (String(button.textContent || '').trim() !== label) continue;
                if (button.closest('.character-prompt-input')) continue;
                candidates.push(button);
            }
        };

        roots.forEach(addButtons);
        getPromptDocuments().forEach(addButtons);

        const unique = uniqueElements(candidates);
        return unique.find(isVisibleUiElement) || unique.find(button => button.isConnected) || null;
    }

    function getMainPromptDiagnostics(kind) {
        try {
            const docs = getPromptDocuments();
            const mainRoots = uniqueElements(docs.flatMap(doc => [...doc.querySelectorAll('.image-gen-prompt-main')]));
            const promptBoxes = uniqueElements(docs.flatMap(doc => [...doc.querySelectorAll('[data-prompt-input="true"]')]));
            const proseMirrors = uniqueElements(docs.flatMap(doc => [...doc.querySelectorAll('.ProseMirror[contenteditable="true"]')]));
            const candidates = collectMainPromptEditors(kind);
            return `main:${mainRoots.length} / promptBox:${promptBoxes.length} / editor:${proseMirrors.length} / candidate:${candidates.length}`;
        } catch (_) {
            return '진단 실패';
        }
    }

    async function activateMainPrompt(kind) {
        const direct = findMainPromptEditor(kind);

        if (direct && isVisiblePromptEditor(direct)) {
            return { ok: true, editor: direct, clicked: false };
        }

        const button = findMainPromptButton(kind);

        if (!button) {
            if (direct) {
                return { ok: true, editor: direct, clicked: false };
            }

            return {
                ok: false,
                error:
                    kind === 'negative'
                        ? `NovelAI Undesired Content 입력창/버튼을 찾지 못했습니다. (${getMainPromptDiagnostics(kind)})`
                        : `NovelAI Base Prompt 입력창/버튼을 찾지 못했습니다. (${getMainPromptDiagnostics(kind)})`
            };
        }

        button.click();

        for (let i = 0; i < 30; i++) {
            await waitMs(50);
            const editor = findMainPromptEditor(kind);

            if (editor && isVisiblePromptEditor(editor)) {
                return { ok: true, editor, clicked: true };
            }
        }

        return {
            ok: false,
            error:
                kind === 'negative'
                    ? 'NovelAI Undesired Content 입력창이 열리지 않았습니다.'
                    : 'NovelAI Base Prompt 입력창이 열리지 않았습니다.'
        };
    }

    function promptText(value) {
        return String(value || '').replace(/\u200B/g, '');
    }

    function placeCaretAtPromptEnd(editor) {
        const paragraphs = [...editor.querySelectorAll('p')];
        const nonEmpty = paragraphs.filter(p => promptText(p.textContent).trim());
        const target = nonEmpty.length
            ? nonEmpty[nonEmpty.length - 1]
            : (paragraphs[paragraphs.length - 1] || editor);

        const selection = PAGE_WINDOW.getSelection
            ? PAGE_WINDOW.getSelection()
            : window.getSelection();
        const range = PAGE_WINDOW.document?.createRange
            ? PAGE_WINDOW.document.createRange()
            : document.createRange();

        range.selectNodeContents(target);
        range.collapse(false);

        selection.removeAllRanges();
        selection.addRange(range);

        return target;
    }

    async function insertIntoPromptEditor(editor, tags) {
        const cleanTags = String(tags || '').trim();

        if (!cleanTags) {
            return { ok: true, skipped: true };
        }

        if (!editor) {
            return {
                ok: false,
                error: 'NovelAI Prompt 입력창을 찾지 못했습니다.'
            };
        }

        try {
            editor.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        } catch (_) {}

        try {
            editor.focus({ preventScroll: true });
        } catch (_) {
            editor.focus();
        }

        const target = placeCaretAtPromptEnd(editor);
        const current = promptText(target.textContent).trimEnd();

        let insertion = cleanTags;

        if (current) {
            insertion = /,$/.test(current)
                ? `\n${cleanTags}`
                : `,\n${cleanTags}`;
        }

        const before = promptText(editor.textContent);
        let commandChanged = false;

        try {
            const pageDocument = PAGE_WINDOW.document || document;
            commandChanged = !!pageDocument.execCommand?.(
                'insertText',
                false,
                insertion
            );
        } catch (_) {
            commandChanged = false;
        }

        await waitMs(40);

        if (promptText(editor.textContent) !== before) {
            try {
                editor.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    inputType: 'insertText',
                    data: insertion
                }));
            } catch (_) {}
            return { ok: true };
        }

        try {
            const selection = PAGE_WINDOW.getSelection
                ? PAGE_WINDOW.getSelection()
                : window.getSelection();

            if (selection && selection.rangeCount) {
                const range = selection.getRangeAt(0);
                const node = (PAGE_WINDOW.document || document).createTextNode(insertion);
                range.deleteContents();
                range.insertNode(node);
                range.setStartAfter(node);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);

                try {
                    editor.dispatchEvent(new InputEvent('input', {
                        bubbles: true,
                        inputType: 'insertText',
                        data: insertion
                    }));
                } catch (_) {
                    editor.dispatchEvent(new Event('input', { bubbles: true }));
                }

                await waitMs(80);
            }
        } catch (_) {}

        if (promptText(editor.textContent) !== before) {
            return { ok: true };
        }

        try {
            const DT = PAGE_WINDOW.DataTransfer || DataTransfer;
            const CE = PAGE_WINDOW.ClipboardEvent || ClipboardEvent;

            if (typeof DT === 'function' && typeof CE === 'function') {
                const data = new DT();
                data.setData('text/plain', insertion);

                editor.dispatchEvent(
                    new CE('paste', {
                        bubbles: true,
                        cancelable: true,
                        clipboardData: data
                    })
                );

                await waitMs(80);
            }
        } catch (_) {}

        if (promptText(editor.textContent) !== before || commandChanged) {
            return { ok: true };
        }

        return {
            ok: false,
            error: 'Prompt 입력창은 찾았지만 태그 삽입 이벤트가 적용되지 않았습니다.'
        };
    }

    function isVisibleUiElement(element) {
        if (!element || !element.isConnected) return false;

        let node = element;
        while (node && node.nodeType === 1) {
            const style = PAGE_WINDOW.getComputedStyle
                ? PAGE_WINDOW.getComputedStyle(node)
                : getComputedStyle(node);

            if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                style.opacity === '0'
            ) {
                return false;
            }

            if (node.getAttribute?.('aria-hidden') === 'true') {
                return false;
            }

            node = node.parentElement;
        }

        const rect = element.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    function getCharacterPromptContainersRaw() {
        return [
            ...PAGE_WINDOW.document.querySelectorAll('.character-prompt-input')
        ];
    }

    function getCharacterPromptIndex(container) {
        if (!container) return 0;

        for (const className of [...(container.classList || [])]) {
            const match = /^character-prompt-input-(\d+)$/.exec(className);
            if (match) return Number(match[1]) || 0;
        }

        return 0;
    }

    function getLogicalCharacterPromptContainers() {
        const groups = new Map();

        for (const container of getCharacterPromptContainersRaw()) {
            const index = getCharacterPromptIndex(container);
            if (!index) continue;

            if (!groups.has(index)) groups.set(index, []);
            groups.get(index).push(container);
        }

        const logical = new Map();

        for (const [index, containers] of groups.entries()) {
            const picked =
                containers.find(isVisibleUiElement) ||
                containers[containers.length - 1] ||
                null;

            if (picked) logical.set(index, picked);
        }

        return logical;
    }

    function getCharacterPromptCount() {
        const indices = [...getLogicalCharacterPromptContainers().keys()];
        return indices.length ? Math.max(...indices) : 0;
    }

    let cachedAddCharacterButton = null;

    function getAddCharacterButtonCandidates() {
        const doc = PAGE_WINDOW.document;
        const headers = [
            ...doc.querySelectorAll('.image-gen-character-prompts-header')
        ];

        const buttons = headers
            .flatMap(header => [...header.querySelectorAll('button')])
            .filter(button => button && !button.disabled && button.isConnected);

        const unique = [...new Set(buttons)];

        if (
            cachedAddCharacterButton &&
            cachedAddCharacterButton.isConnected &&
            !cachedAddCharacterButton.disabled &&
            unique.includes(cachedAddCharacterButton)
        ) {
            return [
                cachedAddCharacterButton,
                ...unique.filter(button => button !== cachedAddCharacterButton)
            ];
        }

        return [
            ...unique.filter(isVisibleUiElement),
            ...unique.filter(button => !isVisibleUiElement(button))
        ];
    }

    function findCharacterPromptContainer(index) {
        const wanted = Math.max(1, Math.floor(Number(index) || 1));
        const logical = getLogicalCharacterPromptContainers();
        const direct = logical.get(wanted);
        if (direct) return direct;

        const doc = PAGE_WINDOW.document;
        const exact = [
            ...doc.querySelectorAll(`.character-prompt-input-${wanted}`)
        ];

        return (
            exact.find(isVisibleUiElement) ||
            exact[exact.length - 1] ||
            null
        );
    }

    function findCharacterPromptEditor(container, index, kind = 'prompt') {
        if (!container) return null;

        const selector = kind === 'negative'
            ? `.prompt-input-box-character-prompts-${index}-undesired-content .ProseMirror[contenteditable="true"]`
            : `.prompt-input-box-character-prompts-${index} .ProseMirror[contenteditable="true"]`;

        const editors = [...container.querySelectorAll(selector)];
        return pickVisibleElement(editors) || editors[editors.length - 1] || null;
    }

    function findCharacterTabButton(container, kind) {
        if (!container) return null;

        const label = kind === 'negative'
            ? 'Undesired Content'
            : 'Prompt';

        return [...container.querySelectorAll('button')].find(button =>
            String(button.textContent || '').trim() === label
        ) || null;
    }

    function getReactClickHandler(button) {
        if (!button) return null;

        const seen = new Set();
        let node = button;
        const stopAt = button.closest?.('.image-gen-character-prompts-header') || null;

        while (node) {
            try {
                const keys = Reflect.ownKeys(node);

                for (const key of keys) {
                    if (
                        typeof key === 'string' &&
                        key.startsWith('__reactProps$')
                    ) {
                        const props = node[key];
                        if (
                            props &&
                            typeof props.onClick === 'function' &&
                            !seen.has(props.onClick)
                        ) {
                            return {
                                handler: props.onClick,
                                currentTarget: node,
                                source: 'reactProps'
                            };
                        }
                    }
                }

                for (const key of keys) {
                    if (
                        typeof key !== 'string' ||
                        !key.startsWith('__reactFiber$')
                    ) {
                        continue;
                    }

                    let fiber = node[key];
                    let depth = 0;

                    while (fiber && depth++ < 4) {
                        for (const props of [fiber.memoizedProps, fiber.pendingProps]) {
                            if (
                                props &&
                                typeof props.onClick === 'function' &&
                                !seen.has(props.onClick)
                            ) {
                                return {
                                    handler: props.onClick,
                                    currentTarget: node,
                                    source: 'reactFiber'
                                };
                            }
                        }
                        fiber = fiber.return;
                    }
                }
            } catch (_) {}

            if (node === stopAt) break;
            node = node.parentElement;
        }

        return null;
    }

    async function invokeReactClickHandler(button) {
        const found = getReactClickHandler(button);
        if (!found) {
            return { ok: false, source: 'none' };
        }

        let defaultPrevented = false;
        let propagationStopped = false;

        const eventLike = {
            type: 'click',
            target: button,
            currentTarget: found.currentTarget || button,
            nativeEvent: null,
            button: 0,
            buttons: 0,
            detail: 1,
            defaultPrevented: false,
            preventDefault() {
                defaultPrevented = true;
                this.defaultPrevented = true;
            },
            stopPropagation() {
                propagationStopped = true;
            },
            isDefaultPrevented() {
                return defaultPrevented;
            },
            isPropagationStopped() {
                return propagationStopped;
            },
            persist() {},
            timeStamp: Date.now()
        };

        try {
            const result = found.handler.call(
                found.currentTarget || button,
                eventLike
            );

            if (result && typeof result.then === 'function') {
                await result;
            }

            return { ok: true, source: found.source };
        } catch (error) {
            console.warn(`[${APP_NAME}] React Character add handler failed:`, error);
            return {
                ok: false,
                source: found.source,
                error
            };
        }
    }

    function dispatchNovelAiButtonClick(button) {
        if (!button) return false;

        try {
            button.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        } catch (_) {}

        try {
            button.focus?.({ preventScroll: true });
        } catch (_) {
            try { button.focus?.(); } catch (_) {}
        }

        try {
            const proto = PAGE_WINDOW.HTMLElement?.prototype;
            if (proto?.click) {
                proto.click.call(button);
                return true;
            }
        } catch (_) {}

        try {
            button.click();
            return true;
        } catch (_) {}

        try {
            const MouseEventCtor = PAGE_WINDOW.MouseEvent || MouseEvent;
            button.dispatchEvent(new MouseEventCtor('click', {
                bubbles: true,
                cancelable: true,
                composed: true,
                button: 0,
                view: PAGE_WINDOW
            }));
            return true;
        } catch (_) {}

        return false;
    }

    function findCharacterGenderChoiceButton(label = 'Other') {
        const doc = PAGE_WINDOW.document;
        const wanted = String(label || '').trim();

        const poppers = [
            ...doc.querySelectorAll('[data-popper-placement]')
        ];

        const matchingPoppers = poppers.filter(popper => {
            const buttons = [...popper.querySelectorAll('button')];
            const labels = buttons.map(button => String(button.textContent || '').trim());
            return labels.includes('Female') && labels.includes('Male') && labels.includes('Other');
        });

        const orderedPoppers = [
            ...matchingPoppers.filter(isVisibleUiElement),
            ...matchingPoppers.filter(popper => !isVisibleUiElement(popper))
        ];

        for (const popper of orderedPoppers) {
            const buttons = [...popper.querySelectorAll('button')];
            const exact = buttons.find(button =>
                !button.disabled &&
                button.isConnected &&
                String(button.textContent || '').trim() === wanted &&
                isVisibleUiElement(button)
            );
            if (exact) return exact;
        }

        return [...doc.querySelectorAll('button')].find(button =>
            !button.disabled &&
            button.isConnected &&
            String(button.textContent || '').trim() === wanted &&
            isVisibleUiElement(button) &&
            button.closest?.('[data-popper-placement]')
        ) || null;
    }

    async function waitForCharacterGenderChoiceButton(label = 'Other', timeoutMs = 1600) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const button = findCharacterGenderChoiceButton(label);
            if (button) return button;
            await waitMs(40);
        }

        return findCharacterGenderChoiceButton(label);
    }

    async function chooseCharacterGenderAndWait(before, label = 'Other') {
        const choiceButton = await waitForCharacterGenderChoiceButton(label, 1600);
        if (!choiceButton) {
            return {
                ok: false,
                reason: 'gender-menu-not-found',
                count: getCharacterPromptCount()
            };
        }

        const domClicked = dispatchNovelAiButtonClick(choiceButton);
        if (domClicked) {
            const afterDomChoice = await waitForCharacterCountAbove(before, 2600);
            if (afterDomChoice > before) {
                return {
                    ok: true,
                    count: afterDomChoice,
                    method: `menu-${String(label).toLowerCase()}`
                };
            }
        }

        const reactResult = await invokeReactClickHandler(choiceButton);
        if (reactResult.ok) {
            const afterReactChoice = await waitForCharacterCountAbove(before, 2600);
            if (afterReactChoice > before) {
                return {
                    ok: true,
                    count: afterReactChoice,
                    method: `menu-${String(label).toLowerCase()}-${reactResult.source}`
                };
            }
        }

        return {
            ok: false,
            reason: 'gender-choice-did-not-create',
            count: getCharacterPromptCount(),
            domClicked,
            reactHandlerFound: reactResult.source !== 'none',
            reactSource: reactResult.source
        };
    }

    async function tryCreateOneCharacter(before, button) {

        const alreadyOpenChoice = findCharacterGenderChoiceButton('Other');
        if (alreadyOpenChoice) {
            const existingMenuResult = await chooseCharacterGenderAndWait(before, 'Other');
            if (existingMenuResult.ok) return existingMenuResult;
        }

        const domClicked = dispatchNovelAiButtonClick(button);

        if (domClicked) {
            const afterDirectClick = await waitForCharacterCountAbove(before, 220);
            if (afterDirectClick > before) {
                return {
                    ok: true,
                    count: afterDirectClick,
                    method: 'dom-click-direct'
                };
            }

            const menuResult = await chooseCharacterGenderAndWait(before, 'Other');
            if (menuResult.ok) return menuResult;
        }

        const reactResult = await invokeReactClickHandler(button);

        if (reactResult.ok) {
            const afterReactDirect = await waitForCharacterCountAbove(before, 220);
            if (afterReactDirect > before) {
                return {
                    ok: true,
                    count: afterReactDirect,
                    method: reactResult.source
                };
            }

            const menuResult = await chooseCharacterGenderAndWait(before, 'Other');
            if (menuResult.ok) {
                return {
                    ...menuResult,
                    method: `${reactResult.source}->${menuResult.method}`
                };
            }
        }

        return {
            ok: false,
            count: getCharacterPromptCount(),
            domClicked,
            reactHandlerFound: reactResult.source !== 'none',
            reactSource: reactResult.source,
            menuDetected: Boolean(findCharacterGenderChoiceButton('Other'))
        };
    }

    async function waitForCharacterCountAbove(before, timeoutMs = 5000) {
        const doc = PAGE_WINDOW.document;

        if (getCharacterPromptCount() > before) {
            return getCharacterPromptCount();
        }

        return await new Promise(resolve => {
            let done = false;
            let observer = null;

            const finish = value => {
                if (done) return;
                done = true;
                try { observer?.disconnect(); } catch (_) {}
                clearTimeout(timer);
                resolve(value);
            };

            observer = new MutationObserver(() => {
                const count = getCharacterPromptCount();
                if (count > before) finish(count);
            });

            try {
                observer.observe(doc.body || doc.documentElement, {
                    childList: true,
                    subtree: true
                });
            } catch (_) {}

            const timer = setTimeout(() => {
                finish(getCharacterPromptCount());
            }, timeoutMs);
        });
    }

    async function ensureCharacterPromptCount(wantedCount) {
        const target = Math.max(0, Math.floor(Number(wantedCount) || 0));
        let safety = 0;

        while (getCharacterPromptCount() < target) {
            if (++safety > target + 12) {
                return {
                    ok: false,
                    error: 'NovelAI Character Prompt 생성 반복이 비정상적으로 길어 중단했습니다.'
                };
            }

            const before = getCharacterPromptCount();
            const addButtons = getAddCharacterButtonCandidates();

            if (!addButtons.length) {
                return {
                    ok: false,
                    error:
                        'NovelAI Character 추가 (+) 버튼 후보를 찾지 못했습니다. ' +
                        '(.image-gen-character-prompts-header button)'
                };
            }

            let created = null;
            const probeInfo = [];

            for (let candidateIndex = 0; candidateIndex < addButtons.length; candidateIndex++) {
                const candidate = addButtons[candidateIndex];

                const currentCount = getCharacterPromptCount();
                if (currentCount > before) {
                    created = {
                        ok: true,
                        count: currentCount,
                        method: 'late-update'
                    };
                    break;
                }

                const attempt = await tryCreateOneCharacter(before, candidate);
                const attemptCount = getCharacterPromptCount();
                const reactInfo = attempt.reactHandlerFound
                    ? attempt.reactSource
                    : 'none';
                const menuInfo = attempt.menuDetected ? 'menu' : 'no-menu';

                probeInfo.push(
                    `#${candidateIndex + 1}:${attempt.method || 'fail'}/${reactInfo}/${menuInfo}/${attemptCount}`
                );

                if (attempt.ok && attemptCount > before) {
                    cachedAddCharacterButton = candidate;
                    created = {
                        ...attempt,
                        count: attemptCount
                    };
                    break;
                }
            }

            const after = created?.count ?? getCharacterPromptCount();

            if (!created?.ok || after <= before) {
                return {
                    ok: false,
                    error:
                        `NovelAI Character 추가 버튼 후보 ${addButtons.length}개를 모두 눌렀지만 ` +
                        `Character가 생성되지 않았습니다. ` +
                        `(현재 ${before}개 / 필요 ${target}개 / ${probeInfo.join(', ') || '진단 없음'})`
                };
            }

            for (let i = 0; i < 40; i++) {
                const container = findCharacterPromptContainer(after);
                if (container?.querySelector('.ProseMirror[contenteditable="true"]')) {
                    break;
                }
                await waitMs(50);
            }
        }

        return {
            ok: true,
            count: getCharacterPromptCount()
        };
    }

    async function activateCharacterPrompt(index, kind) {
        const container = findCharacterPromptContainer(index);

        if (!container) {
            return {
                ok: false,
                error: `NovelAI Character ${index} 영역을 찾지 못했습니다.`
            };
        }

        let editor = findCharacterPromptEditor(container, index, kind);
        if (editor && isVisiblePromptEditor(editor)) {
            return { ok: true, editor, container, clicked: false };
        }

        const button = findCharacterTabButton(container, kind);

        if (!button) {
            if (editor) {
                return { ok: true, editor, container, clicked: false };
            }

            return {
                ok: false,
                error:
                    `NovelAI Character ${index}의 ` +
                    `${kind === 'negative' ? 'Undesired Content' : 'Prompt'} 입력창/탭을 찾지 못했습니다.`
            };
        }

        dispatchNovelAiButtonClick(button);

        for (let i = 0; i < 40; i++) {
            await waitMs(50);
            editor = findCharacterPromptEditor(container, index, kind);

            if (editor && isVisiblePromptEditor(editor)) {
                return { ok: true, editor, container, clicked: true };
            }
        }

        if (editor) {
            return { ok: true, editor, container, clicked: true };
        }

        return {
            ok: false,
            error:
                `NovelAI Character ${index}의 ` +
                `${kind === 'negative' ? 'Undesired Content' : 'Prompt'} 입력창을 찾지 못했습니다.`
        };
    }

    async function waitForCharacterEditorReady(index, timeoutMs = 3000) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const container = findCharacterPromptContainer(index);
            if (container?.querySelector('.ProseMirror[contenteditable="true"]')) {
                return container;
            }
            await waitMs(50);
        }

        return findCharacterPromptContainer(index);
    }

    async function insertConceptIntoNovelAI(item) {
        const normalized = normalizeConceptRecord(item);
        const positive = String(normalized.tags || '').trim();
        const negative = String(normalized.negativeTags || '').trim();
        const characters = normalizeCharacterRows(normalized.characters);

        const hasCharacterContent = characters.some(character =>
            character.prompt || character.negativePrompt
        );

        if (!positive && !negative && !hasCharacterContent) {
            return {
                ok: false,
                error: '삽입할 Prompt가 비어 있습니다.'
            };
        }

        if (positive) {
            const base = await activateMainPrompt('base');
            if (!base.ok) return base;

            const inserted = await insertIntoPromptEditor(base.editor, positive);
            if (!inserted.ok) return inserted;
        }

        if (negative) {
            const undesired = await activateMainPrompt('negative');
            if (!undesired.ok) return undesired;

            const inserted = await insertIntoPromptEditor(
                undesired.editor,
                negative
            );

            if (!inserted.ok) return inserted;
        }

        let insertedCharacters = 0;
        let insertedCharacterNegatives = 0;

        if (characters.length) {
            const ensured = await ensureCharacterPromptCount(characters.length);
            if (!ensured.ok) return ensured;

            for (let i = 0; i < characters.length; i++) {
                const character = characters[i];
                const characterIndex = i + 1;

                const readyContainer = await waitForCharacterEditorReady(characterIndex, 3000);
                if (!readyContainer) {
                    return {
                        ok: false,
                        error: `NovelAI Character ${characterIndex} 슬롯이 생성됐지만 입력창이 준비되지 않았습니다.`
                    };
                }

                if (character.prompt) {
                    const promptTab = await activateCharacterPrompt(
                        characterIndex,
                        'prompt'
                    );

                    if (!promptTab.ok) return promptTab;

                    const inserted = await insertIntoPromptEditor(
                        promptTab.editor,
                        character.prompt
                    );

                    if (!inserted.ok) return inserted;
                    insertedCharacters += 1;
                }

                if (character.negativePrompt) {
                    const negativeTab = await activateCharacterPrompt(
                        characterIndex,
                        'negative'
                    );

                    if (!negativeTab.ok) return negativeTab;

                    const inserted = await insertIntoPromptEditor(
                        negativeTab.editor,
                        character.negativePrompt
                    );

                    if (!inserted.ok) return inserted;
                    insertedCharacterNegatives += 1;
                }

                await activateCharacterPrompt(characterIndex, 'prompt');
            }
        }

        await activateMainPrompt('base');

        return {
            ok: true,
            insertedPositive: Boolean(positive),
            insertedNegative: Boolean(negative),
            insertedCharacters,
            insertedCharacterNegatives
        };
    }

    function nativeFetchWithTimeout(url, opts = {}) {
        const timeoutMs = Math.max(0, Number(opts.timeout || opts.timeoutMs) || 0);

        if (!timeoutMs || typeof AbortController !== 'function') {
            return fetch(url, {
                method: opts.method || 'GET',
                headers: opts.headers || {},
                body: opts.body || null
            });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        return fetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body || null,
            signal: controller.signal
        }).finally(() => clearTimeout(timer));
    }

    function gmFetch(url, opts = {}) {
        if (!GM_XHR) {
            return nativeFetchWithTimeout(url, opts);
        }

        return new Promise((resolve, reject) => {
            const handle = GM_XHR({
                method: opts.method || 'GET',
                url,
                headers: opts.headers || {},
                data: opts.body || null,
                responseType: 'text',
                timeout: Math.max(0, Number(opts.timeout || opts.timeoutMs) || 0),

                onload(response) {
                    const rawHeaders = String(response.responseHeaders || '');

                    resolve({
                        ok: response.status >= 200 && response.status < 300,
                        status: response.status,
                        text: () => Promise.resolve(response.responseText),
                        json: () => Promise.resolve(JSON.parse(response.responseText)),
                        headers: {
                            get(name) {
                                const target = String(name || '').toLowerCase();
                                const line = rawHeaders
                                    .split(/\r?\n/)
                                    .find(header => {
                                        const idx = header.indexOf(':');
                                        return idx >= 0 &&
                                            header.slice(0, idx).trim().toLowerCase() === target;
                                    });

                                return line
                                    ? line.slice(line.indexOf(':') + 1).trim()
                                    : null;
                            }
                        },
                        abort() {
                            try { handle.abort(); } catch (_) {}
                        }
                    });
                },

                onerror() {
                    reject(new Error('네트워크 오류'));
                },

                ontimeout() {
                    reject(new Error('요청 타임아웃'));
                },

                onabort() {
                    reject(new Error('요청 취소됨'));
                }
            });
        });
    }

    async function requestJson(url, opts = {}, label = 'API 요청') {
        const response = await gmFetch(url, {
            ...opts,
            timeout: opts.timeout || 90000
        });

        const raw = await response.text().catch(() => '');

        let data = null;

        try {
            data = raw ? JSON.parse(raw) : null;
        } catch (_) {}

        if (!response.ok) {
            const message =
                data?.error?.message ||
                data?.message ||
                raw.slice(0, 600) ||
                `HTTP ${response.status}`;

            const error = new Error(`${label} 실패: ${response.status} ${message}`);
            error.status = response.status;
            throw error;
        }

        if (data === null) {
            throw new Error(`${label} 응답이 JSON이 아닙니다.`);
        }

        return data;
    }

    function getGeminiResponseText(json) {
        for (const candidate of json?.candidates || []) {
            const text = (candidate?.content?.parts || [])
                .filter(part => part && typeof part.text === 'string' && !part.thought)
                .map(part => part.text)
                .join('')
                .trim();

            if (text) return text;
        }

        return '';
    }

    function getUrlContextStatus(json) {
        const metadata =
            json?.candidates?.[0]?.urlContextMetadata ||
            json?.candidates?.[0]?.url_context_metadata ||
            null;

        const rows =
            metadata?.urlMetadata ||
            metadata?.url_metadata ||
            [];

        if (!Array.isArray(rows) || !rows.length) {
            return null;
        }

        return rows.map(row => ({
            url: row.retrievedUrl || row.retrieved_url || '',
            status: row.urlRetrievalStatus || row.url_retrieval_status || ''
        }));
    }

    function parseServiceAccountJson(value) {
        try {
            const parsed = JSON.parse(String(value || ''));

            if (!parsed.client_email || !parsed.private_key) {
                return {
                    ok: false,
                    error: 'client_email 또는 private_key가 없습니다.'
                };
            }

            return {
                ok: true,
                projectId: parsed.project_id || '',
                clientEmail: parsed.client_email,
                privateKey: parsed.private_key,
                tokenUri:
                    parsed.token_uri ||
                    'https://oauth2.googleapis.com/token'
            };
        } catch (_) {
            return {
                ok: false,
                error: 'Service Account JSON 파싱 실패'
            };
        }
    }

    function base64Url(value) {
        let bytes;

        if (typeof value === 'string') {
            bytes = new TextEncoder().encode(value);
        } else if (value instanceof ArrayBuffer) {
            bytes = new Uint8Array(value);
        } else {
            bytes = value;
        }

        let binary = '';

        for (const byte of bytes) {
            binary += String.fromCharCode(byte);
        }

        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    function pemToArrayBuffer(pem) {
        const base64 = String(pem || '')
            .replace(/-----[A-Z ]+-----/g, '')
            .replace(/\s+/g, '');

        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);

        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return bytes.buffer;
    }

    async function getVertexAccessToken(serviceAccount, cacheKey = 'default') {
        const cacheId = `${cacheKey}:${serviceAccount.clientEmail}`;
        const now = Math.floor(Date.now() / 1000);
        const cached = tokenCache[cacheId];

        if (cached && cached.token && cached.expiry > now + 60) {
            return cached.token;
        }

        const header = base64Url(JSON.stringify({
            alg: 'RS256',
            typ: 'JWT'
        }));

        const claim = base64Url(JSON.stringify({
            iss: serviceAccount.clientEmail,
            sub: serviceAccount.clientEmail,
            aud: serviceAccount.tokenUri,
            iat: now,
            exp: now + 3600,
            scope: 'https://www.googleapis.com/auth/cloud-platform'
        }));

        const signingInput = `${header}.${claim}`;

        const key = await crypto.subtle.importKey(
            'pkcs8',
            pemToArrayBuffer(serviceAccount.privateKey),
            {
                name: 'RSASSA-PKCS1-v1_5',
                hash: 'SHA-256'
            },
            false,
            ['sign']
        );

        const signature = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            key,
            new TextEncoder().encode(signingInput)
        );

        const assertion = `${signingInput}.${base64Url(signature)}`;

        const tokenData = await requestJson(
            serviceAccount.tokenUri,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                body:
                    'grant_type=' +
                    encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
                    '&assertion=' +
                    encodeURIComponent(assertion),
                timeout: 30000
            },
            'Vertex OAuth 토큰 교환'
        );

        tokenCache[cacheId] = {
            token: tokenData.access_token,
            expiry: now + Number(tokenData.expires_in || 3600)
        };

        return tokenData.access_token;
    }

    function resolveVertexEndpoint(location) {
        const value = String(location || 'global').trim() || 'global';

        return {
            location: value,
            host:
                value === 'global'
                    ? 'aiplatform.googleapis.com'
                    : `${value}-aiplatform.googleapis.com`
        };
    }

    function extractBalancedObjectLiteral(source, startIndex = 0) {
        const src = String(source || '');
        const open = src.indexOf('{', startIndex);

        if (open < 0) return '';

        let depth = 0;
        let quote = '';
        let escaped = false;

        for (let i = open; i < src.length; i++) {
            const ch = src[i];

            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (ch === '\\') {
                    escaped = true;
                    continue;
                }

                if (ch === quote) {
                    quote = '';
                }

                continue;
            }

            if (ch === '"' || ch === "'" || ch === '`') {
                quote = ch;
                continue;
            }

            if (ch === '{') depth++;

            if (ch === '}') {
                depth--;

                if (depth === 0) {
                    return src.slice(open, i + 1);
                }
            }
        }

        return '';
    }

    function parseFirebaseConfig(value) {
        const source = String(value || '').trim();

        if (!source) return null;

        try {
            if (source.startsWith('{')) {
                try {
                    return JSON.parse(source);
                } catch (_) {
                    return new Function(`"use strict"; return (${source});`)();
                }
            }

            const assignment = source.search(/firebaseConfig\s*=/i);

            if (assignment >= 0) {
                const objectLiteral = extractBalancedObjectLiteral(source, assignment);

                if (objectLiteral) {
                    return new Function(
                        `"use strict"; return (${objectLiteral});`
                    )();
                }
            }

            const initializeAppIndex = source.search(/initializeApp\s*\(/i);

            if (initializeAppIndex >= 0) {
                const objectLiteral = extractBalancedObjectLiteral(
                    source,
                    initializeAppIndex
                );

                if (objectLiteral) {
                    return new Function(
                        `"use strict"; return (${objectLiteral});`
                    )();
                }
            }

            const firstObject = extractBalancedObjectLiteral(source, 0);

            if (firstObject && /apiKey|projectId/i.test(firstObject)) {
                return new Function(
                    `"use strict"; return (${firstObject});`
                )();
            }
        } catch (_) {}

        return null;
    }

    function loadFirebaseSdk() {
        if (PAGE_WINDOW.__naiConceptLoaderFirebaseSdk) {
            return Promise.resolve(PAGE_WINDOW.__naiConceptLoaderFirebaseSdk);
        }

        if (firebaseSdkPromise) {
            return firebaseSdkPromise;
        }

        firebaseSdkPromise = new Promise((resolve, reject) => {
            const eventName = 'nai-concept-loader-firebase-ready';
            const timeout = setTimeout(() => {
                firebaseSdkPromise = null;
                reject(new Error('Firebase SDK 로드 타임아웃'));
            }, 20000);

            const onReady = () => {
                clearTimeout(timeout);
                const sdk = PAGE_WINDOW.__naiConceptLoaderFirebaseSdk;

                if (!sdk) {
                    firebaseSdkPromise = null;
                    reject(new Error('Firebase SDK 초기화 실패'));
                    return;
                }

                resolve(sdk);
            };

            PAGE_WINDOW.addEventListener(eventName, onReady, { once: true });

            const script = document.createElement('script');
            script.type = 'module';
            script.textContent = `
                import { initializeApp } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-app.js";
                import {
                    getAI,
                    getGenerativeModel,
                    GoogleAIBackend,
                    AgentPlatformBackend,
                    VertexAIBackend
                } from "https://www.gstatic.com/firebasejs/12.17.0/firebase-ai.js";

                window.__naiConceptLoaderFirebaseSdk = {
                    initializeApp,
                    getAI,
                    getGenerativeModel,
                    GoogleAIBackend,
                    AgentPlatformBackend,
                    VertexAIBackend
                };

                window.dispatchEvent(
                    new CustomEvent("${eventName}")
                );
            `;

            script.onerror = () => {
                clearTimeout(timeout);
                firebaseSdkPromise = null;
                reject(new Error('Firebase SDK 스크립트 로드 실패'));
            };

            (document.head || document.documentElement).appendChild(script);
        });

        return firebaseSdkPromise;
    }

    async function callGeminiDeveloper(prompt, settings, options = {}) {
        const model = settings.geminiModel || DEFAULT_MODEL;
        const key = String(settings.geminiKey || '').trim();

        if (!key) {
            throw new Error('Gemini API Key가 없습니다.');
        }

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: String(prompt || '') }]
                }
            ]
        };

        if (options.useUrlContext) {
            body.tools = [{ urlContext: {} }];
        }

        if (options.jsonMode && !options.useUrlContext) {
            body.generationConfig = {
                responseMimeType: 'application/json',
                maxOutputTokens: 8192
            };
        }

        const json = await requestJson(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-goog-api-key': key
                },
                body: JSON.stringify(body),
                timeout: 90000
            },
            'Gemini API'
        );

        const text = getGeminiResponseText(json);

        if (!text) {
            const reason =
                json?.promptFeedback?.blockReason ||
                json?.candidates?.[0]?.finishReason ||
                '응답 없음';

            throw new Error(`Gemini 응답이 비어 있습니다: ${reason}`);
        }

        return {
            text,
            raw: json,
            urlStatus: getUrlContextStatus(json)
        };
    }

    async function callVertex(prompt, settings, options = {}) {
        const parsed = parseServiceAccountJson(settings.vertexJson);

        if (!parsed.ok) {
            throw new Error(parsed.error);
        }

        const projectId =
            String(settings.vertexProjectId || '').trim() ||
            parsed.projectId;

        if (!projectId) {
            throw new Error('Vertex Project ID가 없습니다.');
        }

        const model = settings.vertexModel || DEFAULT_MODEL;
        const endpoint = resolveVertexEndpoint(settings.vertexLocation);
        const token = await getVertexAccessToken(parsed, 'nai-concept-loader');

        const body = {
            contents: [
                {
                    role: 'user',
                    parts: [{ text: String(prompt || '') }]
                }
            ]
        };

        if (options.useUrlContext) {
            body.tools = [{ urlContext: {} }];
        }

        if (options.jsonMode && !options.useUrlContext) {
            body.generationConfig = {
                responseMimeType: 'application/json',
                maxOutputTokens: 8192
            };
        }

        const url =
            `https://${endpoint.host}/v1beta1/projects/${encodeURIComponent(projectId)}` +
            `/locations/${encodeURIComponent(endpoint.location)}` +
            `/publishers/google/models/${encodeURIComponent(model)}:generateContent`;

        let json;

        try {
            json = await requestJson(
                url,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${token}`
                    },
                    body: JSON.stringify(body),
                    timeout: 90000
                },
                'Vertex AI'
            );
        } catch (error) {
            if (error?.status === 401) {
                for (const key of Object.keys(tokenCache)) {
                    if (key.includes(parsed.clientEmail)) {
                        delete tokenCache[key];
                    }
                }

                const refreshedToken = await getVertexAccessToken(
                    parsed,
                    'nai-concept-loader'
                );

                json = await requestJson(
                    url,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${refreshedToken}`
                        },
                        body: JSON.stringify(body),
                        timeout: 90000
                    },
                    'Vertex AI'
                );
            } else {
                throw error;
            }
        }

        const text = getGeminiResponseText(json);

        if (!text) {
            const reason =
                json?.promptFeedback?.blockReason ||
                json?.candidates?.[0]?.finishReason ||
                '응답 없음';

            throw new Error(`Vertex 응답이 비어 있습니다: ${reason}`);
        }

        return {
            text,
            raw: json,
            urlStatus: getUrlContextStatus(json)
        };
    }

    async function callFirebase(prompt, settings, options = {}) {
        const config = parseFirebaseConfig(settings.firebaseConfig);

        if (!config?.apiKey || !config?.projectId) {
            throw new Error(
                'Firebase Config에서 apiKey/projectId를 찾지 못했습니다.'
            );
        }

        const sdk = await loadFirebaseSdk();
        const backendType = settings.firebaseBackend || 'vertex';
        const location = settings.firebaseLocation || 'global';
        const modelName = settings.firebaseModel || DEFAULT_MODEL;

        const appName =
            `nai-concept-loader-${simpleHash(config.apiKey + ':' + config.projectId)}`;

        let app = firebaseAppCache[appName];

        if (!app) {
            app = sdk.initializeApp(config, appName);
            firebaseAppCache[appName] = app;
        }

        const aiKey = `${appName}|${backendType}|${location}`;
        let ai = firebaseAiCache[aiKey];

        if (!ai) {
            const backend =
                backendType === 'googleai'
                    ? new sdk.GoogleAIBackend()
                    : sdk.AgentPlatformBackend
                        ? new sdk.AgentPlatformBackend(location || 'global')
                        : new sdk.VertexAIBackend(location || 'global');

            ai = sdk.getAI(app, { backend });
            firebaseAiCache[aiKey] = ai;
        }

        const modelKey =
            `${aiKey}|${modelName}|${options.useUrlContext ? 'url' : 'plain'}|` +
            `${options.jsonMode ? 'json' : 'text'}`;

        let model = firebaseModelCache[modelKey];

        if (!model) {
            const modelOptions = {
                model: modelName
            };

            if (options.useUrlContext) {
                modelOptions.tools = [{ urlContext: {} }];
            }

            if (options.jsonMode && !options.useUrlContext) {
                modelOptions.generationConfig = {
                    responseMimeType: 'application/json',
                    maxOutputTokens: 8192
                };
            }

            model = sdk.getGenerativeModel(ai, modelOptions);
            firebaseModelCache[modelKey] = model;
        }

        let result;
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                result = await Promise.race([
                    model.generateContent(String(prompt || '')),
                    new Promise((_, reject) => {
                        setTimeout(
                            () => reject(new Error('Firebase 생성 요청 타임아웃')),
                            90000
                        );
                    })
                ]);
                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                const message = String(error?.message || error || '');
                if (!/Failed to fetch/i.test(message) || attempt >= 1) break;
                await waitMs(1200);
            }
        }

        if (lastError) {
            const message = String(lastError?.message || lastError || '');
            if (/Failed to fetch/i.test(message)) {
                throw new Error(
                    'Firebase AI Logic 네트워크 요청이 2회 연속 실패했습니다. ' +
                    '모델/Prompt 문제가 아니라 브라우저에서 Firebase AI 엔드포인트 응답을 받지 못한 오류입니다. ' +
                    'Firebase AI 설정, 브라우저 확장 차단, 네트워크 상태를 확인해주세요.'
                );
            }
            throw lastError;
        }

        const text = result?.response?.text?.() || '';

        if (!text) {
            throw new Error('Firebase AI 응답이 비어 있습니다.');
        }

        const candidate = result?.response?.candidates?.[0] || null;
        const rawMetadata =
            candidate?.urlContextMetadata ||
            candidate?.url_context_metadata ||
            null;

        let urlStatus = null;

        if (rawMetadata) {
            const rows =
                rawMetadata.urlMetadata ||
                rawMetadata.url_metadata ||
                [];

            if (Array.isArray(rows) && rows.length) {
                urlStatus = rows.map(row => ({
                    url: row.retrievedUrl || row.retrieved_url || '',
                    status:
                        row.urlRetrievalStatus ||
                        row.url_retrieval_status ||
                        ''
                }));
            }
        }

        return {
            text,
            raw: result,
            urlStatus
        };
    }

    async function callProvider(prompt, settings, options = {}) {
        const provider = settings.provider || 'gemini';

        if (provider === 'gemini') {
            return callGeminiDeveloper(prompt, settings, options);
        }

        if (provider === 'vertex') {
            return callVertex(prompt, settings, options);
        }

        if (provider === 'firebase') {
            return callFirebase(prompt, settings, options);
        }

        throw new Error(`지원하지 않는 provider: ${provider}`);
    }

    function buildAnalyzePrompt(url, pageText = '', settings = {}) {
        const sourcePart = pageText
            ? `
아래는 페이지에서 직접 가져온 텍스트다.
이 텍스트만 근거로 분석하라.

--- PAGE TEXT START ---
${pageText}
--- PAGE TEXT END ---
`
            : `
다음 공개 URL을 URL Context 도구로 직접 읽어라:
${url}
`;

        return `
너는 NovelAI 이미지 생성용 "공유 Prompt 세트"를 원문 그대로 추출하는 분석기다.

${sourcePart}

가장 중요한 규칙:
- 너의 역할은 "창작/개선"이 아니라 "정확한 추출"이다.
- 태그를 추가, 삭제, 번역, 재정렬, 교정, 요약하지 마라.
- 원문의 쉼표, 가중치 문법(::, {}, [] 등), # 접두사, 순서를 그대로 보존하라.
- 원문에 의미 있는 줄바꿈이 있으면 문자열 내부에서도 그대로 보존하라.
- 하나의 완성된 Prompt 세트 안에 공통 Prompt와 Character Prompt가 있으면 절대로 여러 concept로 쪼개지 마라.
- "공통 Prompt", "Base Prompt", "Common Prompt", "Scene Prompt" 등 전체에 적용되는 Prompt는 tags에 넣어라.
- "Character 1 Prompt", "Character 2 Prompt", "Character N Prompt"처럼 캐릭터 번호/라벨이 명시된 경우에만 characters 배열로 분리하라.
- 단순히 줄이 나뉘어 있거나 문단이 여러 개라는 이유만으로 Character Prompt라고 추측하지 마라. 그런 경우에는 tags 하나에 줄바꿈을 보존해서 넣어라.
- "Negative Prompt", "Undesired Content", "UC", "Negative" 등 전체 네거티브 영역은 negativeTags에 넣어라.
- "Character 1 Undesired Content", "Character 1 Negative Prompt"처럼 특정 캐릭터에 명시적으로 붙은 네거티브는 해당 characters 항목의 negativePrompt에 넣어라.
- 공통 Prompt / Character 1 / Character 2는 서로 다른 컨셉이 아니라 같은 세트의 구성요소다.
- 페이지에 서로 완전히 독립된 여러 예시/프리셋/세트가 명확히 존재할 때만 concepts를 여러 개 반환하라.
- 설명문, 목차, 사용법, 버튼명, 이미지 캡션, 문장형 해설은 Prompt 태그에 포함하지 마라.
- 단, 해당 Prompt 세트 바로 주변에 작성자가 남긴 짧은 사용 팁/주의사항/추천 조합/수정 지시가 있으면 note에 보존하라.
- note에는 원문에서 실제 확인되는 내용만 넣고 새 설명을 만들거나 요약·추측하지 마라. 짧은 원문 문구의 의미와 표현을 최대한 유지하라.
- 해당 세트와 직접 관계없는 잡담, 목차, 긴 일반 설명, 페이지 소개는 note에도 넣지 마라.
- 메모로 남길 만한 원문이 없으면 note는 빈 문자열로 반환하라.
- suggestedName은 실제 태그의 핵심 장면/용도/효과를 나타내는 간략한 제목으로 만든다.
- suggestedName 앞에 "Nai 공유 태그 -", "NAI 공유 태그 -", "공유 태그 -", "Prompt -", "프롬프트 -", "태그 -" 같은 상투적인 접두어를 절대 붙이지 마라.
- 페이지 제목을 기계적으로 복사하지 말고 태그 내용을 기준으로 "노트북 셀카", "피임 필수"처럼 짧고 구체적인 이름을 제안하라.
- 실제 공유 Prompt인지 확신이 약하면 제외하라.
- characters가 없으면 빈 배열 []로 반환하라.
- JSON 하나만 출력하고 마크다운 코드블록/설명은 금지한다.

반환 형식:
{
  "pageTitle": "페이지 제목 또는 빈 문자열",
  "concepts": [
    {
      "suggestedName": "태그 내용을 나타내는 짧고 구체적인 제목",
      "sectionLabel": "원문의 세트/프리셋 라벨 또는 빈 문자열",
      "tags": "Base/Common/Positive Prompt. 없으면 빈 문자열",
      "negativeTags": "전체 Negative/Undesired Content. 없으면 빈 문자열",
      "characters": [
        {
          "name": "Character 1",
          "prompt": "해당 캐릭터 Prompt. 없으면 빈 문자열",
          "negativePrompt": "해당 캐릭터 Negative/Undesired Content. 없으면 빈 문자열"
        }
      ],
      "note": "해당 세트 주변의 작성자 사용 팁/주의사항 원문. 없으면 빈 문자열"
    }
  ]
}

`.trim();
    }

    function stripJsonFence(text) {
        let value = String(text || '').trim();

        value = value
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        return value;
    }

    function findBalancedJsonObject(text) {
        const src = String(text || '');
        const start = src.indexOf('{');

        if (start < 0) return '';

        let depth = 0;
        let quote = '';
        let escaped = false;

        for (let i = start; i < src.length; i++) {
            const ch = src[i];

            if (quote) {
                if (escaped) {
                    escaped = false;
                    continue;
                }

                if (ch === '\\') {
                    escaped = true;
                    continue;
                }

                if (ch === quote) {
                    quote = '';
                }

                continue;
            }

            if (ch === '"') {
                quote = '"';
                continue;
            }

            if (ch === '{') depth++;

            if (ch === '}') {
                depth--;

                if (depth === 0) {
                    return src.slice(start, i + 1);
                }
            }
        }

        return '';
    }

    function parseLooseJsonObject(text) {
        const cleaned = stripJsonFence(text);
        const attempts = [
            cleaned,
            findBalancedJsonObject(cleaned)
        ].filter(Boolean);

        for (const candidate of attempts) {
            try {
                const parsed = JSON.parse(candidate);

                if (parsed && typeof parsed === 'object') {
                    return parsed;
                }
            } catch (_) {}
        }

        throw new Error('AI 응답 JSON 파싱에 실패했습니다.');
    }

    function parseAnalysisJson(text) {
        const parsed = parseLooseJsonObject(text);
        const concepts = Array.isArray(parsed.concepts)
            ? parsed.concepts
            : [];

        const normalized = concepts
            .map((item, index) => {
                const tags = String(
                    item?.tags ??
                    item?.basePrompt ??
                    item?.prompt ??
                    item?.positivePrompt ??
                    ''
                ).trim();

                const negativeTags = String(
                    item?.negativeTags ??
                    item?.negativePrompt ??
                    item?.undesiredContent ??
                    ''
                ).trim();

                const characters = normalizeCharacterRows(
                    item?.characters ??
                    item?.characterPrompts ??
                    []
                );

                if (!tags && !negativeTags && !characters.length) {
                    return null;
                }

                return {
                    id: createId(),
                    selected: true,
                    suggestedName:
                        String(item?.suggestedName || '').trim() ||
                        `컨셉 ${index + 1}`,
                    sectionLabel: String(
                        item?.sectionLabel ??
                        item?.setLabel ??
                        ''
                    ).trim(),
                    tags,
                    negativeTags,
                    characters,
                    note: String(item?.note || '').trim()
                };
            })
            .filter(Boolean);

        return {
            pageTitle: String(parsed.pageTitle || '').trim(),
            concepts: normalized
        };
    }

    async function fetchPublicPageSnapshot(url) {
        const response = await gmFetch(url, {
            method: 'GET',
            headers: {
                Accept:
                    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'no-cache'
            },
            timeout: 20000
        });

        if (!response.ok) {
            throw new Error(`원문 직접 가져오기 실패: HTTP ${response.status}`);
        }

        const raw = await response.text();

        if (!raw) {
            throw new Error('원문 직접 가져오기 결과가 비어 있습니다.');
        }

        const contentType = response.headers?.get?.('content-type') || '';
        const links = [];
        let title = '';
        let text = '';

        if (
            contentType.includes('text/plain') ||
            contentType.includes('application/json')
        ) {
            text = raw;
        } else {
            const doc = new DOMParser().parseFromString(raw, 'text/html');
            title = doc.title || '';

            for (const anchor of doc.querySelectorAll('a[href]')) {
                const resolved = cleanDiscoveredUrl(
                    anchor.getAttribute('href'),
                    url
                );

                if (!resolved) continue;

                links.push({
                    url: resolved,
                    title: String(anchor.textContent || '').trim()
                });
            }

            const absoluteMatches = raw.match(
                /https?:\\?\/\\?\/[^\s"'<>\\]+/gi
            ) || [];

            for (const candidate of absoluteMatches.slice(0, 400)) {
                const resolved = cleanDiscoveredUrl(candidate, url);
                if (resolved) links.push({ url: resolved, title: '' });
            }

            for (const element of doc.querySelectorAll(
                'script, style, noscript, svg, canvas'
            )) {
                element.remove();
            }

            text = (doc.body?.textContent || doc.documentElement?.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n[ \t]+/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
        }

        const combined = title
            ? `PAGE TITLE: ${title}\n\n${text}`
            : text;

        return {
            raw,
            title,
            text: combined.slice(0, 140000),
            links
        };
    }

    async function fetchPublicPageText(url) {
        const snapshot = await fetchPublicPageSnapshot(url);

        if (snapshot.text.length < 20) {
            throw new Error('원문에서 읽을 수 있는 텍스트를 찾지 못했습니다.');
        }

        return snapshot.text;
    }

    function urlContextClearlyFailed(urlStatus) {
        if (!Array.isArray(urlStatus) || !urlStatus.length) {
            return false;
        }

        return urlStatus.every(item => {
            const status = String(item?.status || '');
            return !status.includes('SUCCESS');
        });
    }

    function conceptFingerprint(tags, negativeTags = '', characters = []) {
        const compact = value => String(value || '')
            .replace(/\s+/g, ' ')
            .replace(/\s*,\s*/g, ',')
            .trim()
            .toLowerCase();

        const positive = compact(tags);
        const negative = compact(negativeTags);

        const characterPart = normalizeCharacterRows(characters)
            .map((character, index) => [
                compact(character.name || `Character ${index + 1}`),
                compact(character.prompt),
                compact(character.negativePrompt)
            ].join('|'))
            .join('\n');

        return [
            positive,
            '---NEG---',
            negative,
            '---CHARACTERS---',
            characterPart
        ].join('\n').trim();
    }

    function sleepMs(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function notionCrawlerJobRead() {
        const job = GM_getValue(NOTION_BROWSER_JOB_KEY, null);
        return job && typeof job === 'object' ? job : null;
    }

    function notionCrawlerJobWrite(job) {
        GM_setValue(NOTION_BROWSER_JOB_KEY, {
            ...job,
            updatedAt: Date.now()
        });
    }

    function notionCrawlerCurrentKey(url) {
        return notionPageKey(url);
    }

    function notionCrawlerBadge(text) {
        if (!document.body) return;

        let badge = document.getElementById('nai-notion-crawler-badge');
        if (!badge) {
            badge = document.createElement('div');
            badge.id = 'nai-notion-crawler-badge';
            badge.style.cssText = [
                'position:fixed',
                'right:14px',
                'top:14px',
                'z-index:2147483647',
                'max-width:360px',
                'padding:10px 12px',
                'border-radius:7px',
                'background:rgba(24,26,42,.94)',
                'color:white',
                'font:12px/1.5 system-ui,sans-serif',
                'box-shadow:0 8px 30px rgba(0,0,0,.35)',
                'white-space:pre-wrap',
                'pointer-events:none'
            ].join(';');
            document.body.appendChild(badge);
        }

        badge.textContent = text;
    }

    function notionNetworkShouldCapture(url) {
        const value = String(url || '');
        return /\/api\/v3\//i.test(value) || /\/api\/public\//i.test(value);
    }

    function notionNetworkCapturePriority(url) {
        const value = String(url || '').toLowerCase();
        if (value.includes('querycollection')) return 100;
        if (value.includes('loadcachedpagechunk')) return 95;
        if (value.includes('loadpagechunk')) return 90;
        if (value.includes('getpublicpagedata')) return 85;
        if (value.includes('getpublicspacedata')) return 80;
        if (value.includes('syncrecordvalues')) return 75;
        if (value.includes('collection')) return 70;
        if (value.includes('page')) return 60;
        return 10;
    }

    function notionNetworkRecordCapture(entry) {
        try {
            const job = notionCrawlerJobRead();
            if (!job || job.status !== 'running' || job.mode !== 'network-intercept') return;

            const responseText = String(entry?.responseText || '');
            if (!responseText || responseText.length < 2) return;

            const requestBody = String(entry?.requestBody || '').slice(0, 30000);
            const isQueryCollection = /\/queryCollection(?:\?|$)/i.test(String(entry?.url || ''));
            let queryCollection = job.queryCollection && typeof job.queryCollection === 'object'
                ? { ...job.queryCollection }
                : null;

            // queryCollection 응답은 수백 KB~수 MB가 될 수 있다.
            // GM 저장소에는 전체 응답을 넣지 않고, row ID / hasMore / compiledRequest만
            // 즉시 뽑아 compact state로 보존한다.
            if (isQueryCollection) {
                const parsed = notionNetworkParseJson(responseText);
                const group =
                    parsed?.result?.reducerResults?.collection_group_results ||
                    null;
                const blockIds = Array.isArray(group?.blockIds)
                    ? group.blockIds.filter(id => typeof id === 'string' && id.length >= 30)
                    : [];
                const previousIds = Array.isArray(queryCollection?.blockIds)
                    ? queryCollection.blockIds
                    : [];
                const mergedIds = [...new Set([...previousIds, ...blockIds])];

                const previousRows = {};
                for (const row of Array.isArray(queryCollection?.rowRecords)
                    ? queryCollection.rowRecords
                    : []) {
                    if (row?.id) previousRows[row.id] = row;
                }
                const compactRows = notionNetworkExtractCompactBlocks(parsed, blockIds);
                Object.assign(previousRows, compactRows);

                // IMPORTANT: image metadata is kept separately from rowRecords.
                // Do not mutate/merge the row graph here; that graph is the proven
                // v2_41 text-reconstruction path.
                const imagePropertyIds = [
                    ...new Set([
                        ...(Array.isArray(queryCollection?.imagePropertyIds)
                            ? queryCollection.imagePropertyIds
                            : []),
                        ...notionNetworkExtractImagePropertyIds(parsed)
                    ])
                ];
                const rowImageRefs = {
                    ...(queryCollection?.rowImageRefs &&
                    typeof queryCollection.rowImageRefs === 'object'
                        ? queryCollection.rowImageRefs
                        : {})
                };
                for (const [rowId, row] of Object.entries(compactRows)) {
                    const attachment = notionNetworkImageAttachmentFromRow(
                        row,
                        imagePropertyIds
                    );
                    if (!attachment) continue;
                    rowImageRefs[rowId] = {
                        attachment,
                        spaceId: String(row?.space_id || '')
                    };
                }

                const propertyNames = {
                    ...(queryCollection?.propertyNames && typeof queryCollection.propertyNames === 'object'
                        ? queryCollection.propertyNames
                        : {}),
                    ...notionNetworkExtractPropertyNames(parsed)
                };

                queryCollection = {
                    ...(queryCollection || {}),
                    url: String(entry?.url || queryCollection?.url || ''),
                    requestBody: requestBody || String(queryCollection?.requestBody || ''),
                    requestPayload:
                        notionNetworkParseJson(requestBody) ||
                        queryCollection?.requestPayload ||
                        null,
                    blockIds: mergedIds,
                    // Save the actual 50 row page records immediately.  In the
                    // real response these records already contain each row's
                    // child `content` ids even though the child blocks are not
                    // present yet.
                    rowRecords: Object.values(previousRows).slice(0, 500),
                    propertyNames,
                    imagePropertyIds,
                    rowImageRefs,
                    hasMore: Boolean(group?.hasMore),
                    sizeHint: Math.max(
                        Number(queryCollection?.sizeHint || 0),
                        Number(parsed?.result?.sizeHint || 0),
                        mergedIds.length
                    ),
                    rowCountStatus:
                        String(parsed?.result?.rowCountStatus || queryCollection?.rowCountStatus || ''),
                    compiledRequest:
                        parsed?.compiledRequest && typeof parsed.compiledRequest === 'object'
                            ? parsed.compiledRequest
                            : (queryCollection?.compiledRequest || null),
                    capturedAt: Date.now()
                };
            }

            const trimmedResponse = responseText.slice(
                0,
                isQueryCollection ? 620000 : 520000
            );
            const signature = simpleHash([
                entry?.method || 'GET',
                entry?.url || '',
                requestBody,
                trimmedResponse.slice(0, 4000)
            ].join('|'));
            const existing = Array.isArray(job.captures) ? job.captures : [];
            if (existing.some(row => row.signature === signature)) {
                // 중복 응답이라도 queryCollection compact state는 놓치지 않는다.
                if (queryCollection !== job.queryCollection) {
                    notionCrawlerJobWrite({
                        ...job,
                        queryCollection,
                        lastCaptureAt: Date.now(),
                        message:
                            `Notion queryCollection 감지 · row ${queryCollection?.blockIds?.length || 0}개` +
                            (queryCollection?.sizeHint
                                ? ` / 약 ${queryCollection.sizeHint}개`
                                : '')
                    });
                }
                return;
            }

            let totalChars = existing.reduce(
                (sum, row) =>
                    sum +
                    String(row.responseText || '').length +
                    String(row.requestBody || '').length,
                0
            );
            if (totalChars >= NOTION_NETWORK_MAX_CAPTURE_CHARS && !isQueryCollection) return;

            const remaining = Math.max(
                0,
                NOTION_NETWORK_MAX_CAPTURE_CHARS - totalChars
            );
            const capture = {
                signature,
                url: String(entry?.url || ''),
                method: String(entry?.method || 'GET'),
                status: Number(entry?.status || 0),
                requestBody,
                responseText: isQueryCollection
                    ? trimmedResponse
                    : trimmedResponse.slice(0, remaining),
                priority: notionNetworkCapturePriority(entry?.url),
                capturedAt: Date.now()
            };

            const captures = [...existing, capture]
                .sort(
                    (a, b) =>
                        (b.priority || 0) - (a.priority || 0) ||
                        (a.capturedAt || 0) - (b.capturedAt || 0)
                )
                .slice(0, 40);

            notionCrawlerJobWrite({
                ...job,
                captures,
                queryCollection,
                lastCaptureAt: Date.now(),
                message: queryCollection?.blockIds?.length
                    ? `Notion queryCollection 감지 · row ${queryCollection.blockIds.length}개` +
                      (queryCollection.sizeHint
                          ? ` / 약 ${queryCollection.sizeHint}개`
                          : '')
                    : `Notion 내부 API 응답 가로채는 중… ${captures.length}개`
            });
        } catch (_) {}
    }

    function installNotionNetworkInterceptor() {
        const page = PAGE_WINDOW;
        if (page.__naiNotionNetworkInterceptorInstalled) return;
        page.__naiNotionNetworkInterceptorInstalled = true;

        try {
            const originalFetch = page.fetch;
            if (typeof originalFetch === 'function') {
                page.fetch = async function(input, init) {
                    const url = typeof input === 'string' ? input : (input?.url || '');
                    const method = String(init?.method || input?.method || 'GET').toUpperCase();
                    const requestBody = typeof init?.body === 'string' ? init.body : '';
                    const response = await originalFetch.apply(this, arguments);
                    if (notionNetworkShouldCapture(url)) {
                        try {
                            const clone = response.clone();
                            clone.text().then(responseText => notionNetworkRecordCapture({
                                url, method, requestBody, status: response.status, responseText
                            })).catch(() => {});
                        } catch (_) {}
                    }
                    return response;
                };
            }
        } catch (_) {}

        try {
            const XHR = page.XMLHttpRequest;
            if (XHR?.prototype) {
                const originalOpen = XHR.prototype.open;
                const originalSend = XHR.prototype.send;
                XHR.prototype.open = function(method, url) {
                    this.__naiMethod = method;
                    this.__naiUrl = url;
                    return originalOpen.apply(this, arguments);
                };
                XHR.prototype.send = function(body) {
                    this.__naiRequestBody = typeof body === 'string' ? body : '';
                    if (notionNetworkShouldCapture(this.__naiUrl)) {
                        this.addEventListener('loadend', () => {
                            try {
                                const responseText = typeof this.responseText === 'string' ? this.responseText : '';
                                notionNetworkRecordCapture({
                                    url: this.__naiUrl,
                                    method: this.__naiMethod || 'GET',
                                    requestBody: this.__naiRequestBody || '',
                                    status: this.status,
                                    responseText
                                });
                            } catch (_) {}
                        }, { once: true });
                    }
                    return originalSend.apply(this, arguments);
                };
            }
        } catch (_) {}
    }


    function notionNetworkParseJson(text) {
        try {
            return JSON.parse(String(text || ''));
        } catch (_) {
            return null;
        }
    }

    function notionNetworkDashedUuid(value) {
        const compact = String(value || '')
            .trim()
            .replace(/[^0-9a-f]/gi, '')
            .toLowerCase();
        if (compact.length !== 32) return '';
        return [
            compact.slice(0, 8),
            compact.slice(8, 12),
            compact.slice(12, 16),
            compact.slice(16, 20),
            compact.slice(20)
        ].join('-');
    }

    function notionNetworkIdsFromPublicUrl(rootUrl) {
        try {
            const url = new URL(rootUrl);
            const path = decodeURIComponent(url.pathname || '');
            const pathMatch = path.match(/([0-9a-f]{32})(?:\/)?$/i);
            const viewRaw = url.searchParams.get('v') || '';
            return {
                pageId: notionNetworkDashedUuid(pathMatch?.[1] || ''),
                viewId: notionNetworkDashedUuid(viewRaw)
            };
        } catch (_) {
            return { pageId: '', viewId: '' };
        }
    }

    function notionNetworkUnwrapRecord(record) {
        if (!record || typeof record !== 'object') return null;
        let value = record.value;
        if (value && typeof value === 'object' && value.value && typeof value.value === 'object') {
            value = value.value;
        }
        return value && typeof value === 'object' ? value : null;
    }


    // Keep only the parts of an internal Notion block that are useful for
    // reconstructing a public DB row.  queryCollection responses can be close
    // to 1 MB because of CRDT data; saving that whole JSON in GM storage made
    // the interceptor fragile.  This compact form is enough for title,
    // properties, and the child-block graph.
    function notionNetworkCompactBlockRecord(id, record) {
        const value = notionNetworkUnwrapRecord(record);
        if (!value || typeof value !== 'object') return null;
        const spaceId =
            String(record?.spaceId || '') ||
            String(record?.value?.spaceId || '') ||
            String(value?.space_id || value?.spaceId || '');
        const properties =
            value.properties && typeof value.properties === 'object'
                ? value.properties
                : {};
        return {
            id: String(value.id || id || ''),
            type: String(value.type || ''),
            properties,
            content: Array.isArray(value.content)
                ? value.content.filter(child => typeof child === 'string')
                : [],
            parent_id: String(value.parent_id || value.parentId || ''),
            parent_table: String(value.parent_table || value.parentTable || ''),
            space_id: spaceId,
            // Preserve the original Notion attachment reference separately.
            // Later syncRecordValues responses can contain a slimmer copy of
            // the same row and must not erase the image property.
            attachment_ref: notionNetworkFindAttachmentRef(properties)
        };
    }

    function notionNetworkMergeCompactBlock(existing, incoming) {
        if (!existing) return incoming;
        if (!incoming) return existing;

        const existingProps =
            existing.properties && typeof existing.properties === 'object'
                ? existing.properties
                : {};
        const incomingProps =
            incoming.properties && typeof incoming.properties === 'object'
                ? incoming.properties
                : {};

        return {
            ...existing,
            ...incoming,
            id: String(incoming.id || existing.id || ''),
            type: String(incoming.type || existing.type || ''),
            properties: {
                ...existingProps,
                ...incomingProps
            },
            content: [
                ...new Set([
                    ...(Array.isArray(existing.content) ? existing.content : []),
                    ...(Array.isArray(incoming.content) ? incoming.content : [])
                ])
            ],
            parent_id: String(incoming.parent_id || existing.parent_id || ''),
            parent_table: String(incoming.parent_table || existing.parent_table || ''),
            space_id: String(incoming.space_id || existing.space_id || ''),
            attachment_ref:
                String(incoming.attachment_ref || '') ||
                String(existing.attachment_ref || '') ||
                notionNetworkFindAttachmentRef(incomingProps) ||
                notionNetworkFindAttachmentRef(existingProps)
        };
    }

    function notionNetworkMergeCompactBlocks(target, incomingMap) {
        for (const [id, incoming] of Object.entries(incomingMap || {})) {
            target[id] = notionNetworkMergeCompactBlock(target[id], incoming);
        }
        return target;
    }

    function notionNetworkExtractCompactBlocks(parsed, onlyIds = null) {
        const result = {};
        const blockMap = parsed?.recordMap?.block;
        if (!blockMap || typeof blockMap !== 'object') return result;
        const wanted = onlyIds ? new Set(onlyIds) : null;
        for (const [id, record] of Object.entries(blockMap)) {
            if (wanted && !wanted.has(id)) continue;
            const compact = notionNetworkCompactBlockRecord(id, record);
            if (compact?.id) result[compact.id] = compact;
        }
        return result;
    }

    function notionNetworkFindAttachmentRef(value, depth = 0) {
        if (depth > 12 || value === null || value === undefined) return '';
        if (typeof value === 'string') {
            return /^attachment:/i.test(value) ? value : '';
        }
        if (Array.isArray(value)) {
            for (const child of value) {
                const found = notionNetworkFindAttachmentRef(child, depth + 1);
                if (found) return found;
            }
            return '';
        }
        if (typeof value === 'object') {
            for (const child of Object.values(value)) {
                const found = notionNetworkFindAttachmentRef(child, depth + 1);
                if (found) return found;
            }
        }
        return '';
    }

    function notionNetworkPublicImageUrl(rootUrl, pageId, spaceId, properties, preservedAttachment = '') {
        const attachment =
            String(preservedAttachment || '') ||
            notionNetworkFindAttachmentRef(properties);
        if (!attachment || !pageId) return '';
        try {
            const origin = new URL(rootUrl).origin;
            // Match the URL shape Notion itself uses for public database images.
            // Keep this stable proxy URL in cache; Notion will 302 it to a fresh
            // img.notionusercontent.com signed URL when the image is requested.
            const params = [
                `id=${encodeURIComponent(String(pageId))}`,
                'table=block'
            ];
            if (spaceId) params.push(`spaceId=${encodeURIComponent(String(spaceId))}`);
            params.push('width=540');
            params.push('userId=');
            params.push('cache=v2');
            params.push('imgBuildSrc=requestProxiedImageUrl');
            return `${origin}/image/${encodeURIComponent(attachment)}?${params.join('&')}`;
        } catch (_) {
            return '';
        }
    }

    function notionNetworkExtractPropertyNames(parsed) {
        const names = {};
        const collectionMap = parsed?.recordMap?.collection;
        if (!collectionMap || typeof collectionMap !== 'object') return names;
        for (const record of Object.values(collectionMap)) {
            const value = notionNetworkUnwrapRecord(record);
            const schema = value?.schema;
            if (!schema || typeof schema !== 'object') continue;
            for (const [propertyId, definition] of Object.entries(schema)) {
                const name = String(definition?.name || definition?.id || propertyId || '').trim();
                if (name) names[propertyId] = name;
            }
        }
        return names;
    }

    function notionNetworkExtractImagePropertyIds(parsed) {
        const ids = [];
        const collectionMap = parsed?.recordMap?.collection;
        if (!collectionMap || typeof collectionMap !== 'object') return ids;

        for (const record of Object.values(collectionMap)) {
            const value = notionNetworkUnwrapRecord(record);
            const schema = value?.schema;
            if (!schema || typeof schema !== 'object') continue;

            for (const [propertyId, definition] of Object.entries(schema)) {
                const type = String(definition?.type || '').trim().toLowerCase();
                const name = String(definition?.name || '').trim().toLowerCase();
                if (
                    type === 'file' ||
                    type === 'files' ||
                    /^(이미지|image|images|사진|photo|thumbnail|썸네일)$/.test(name)
                ) {
                    ids.push(propertyId);
                }
            }
        }
        return [...new Set(ids)];
    }

    function notionNetworkImageAttachmentFromRow(row, imagePropertyIds = []) {
        const props = row?.properties;
        if (!props || typeof props !== 'object') return '';

        for (const propertyId of imagePropertyIds || []) {
            if (!Object.prototype.hasOwnProperty.call(props, propertyId)) continue;
            const found = notionNetworkFindAttachmentRef(props[propertyId]);
            if (found) return found;
        }
        return notionNetworkFindAttachmentRef(props);
    }

    function notionNetworkSyntheticCapture(blockRecords, propertyNames = {}) {
        const block = {};
        for (const [id, value] of Object.entries(blockRecords || {})) {
            if (!value || typeof value !== 'object') continue;
            const spaceId = String(value.space_id || value.spaceId || '');
            block[id] = {
                ...(spaceId ? { spaceId } : {}),
                value: { value }
            };
        }

        const schema = {};
        for (const [id, name] of Object.entries(propertyNames || {})) {
            schema[id] = { name };
        }

        const recordMap = { block };
        if (Object.keys(schema).length) {
            recordMap.collection = {
                __nai_collection__: {
                    value: { value: { schema } }
                }
            };
        }

        return {
            url: 'nai://notion-compact-record-map',
            method: 'POST',
            status: 200,
            requestBody: '',
            responseText: JSON.stringify({ recordMap }),
            priority: 120,
            capturedAt: Date.now()
        };
    }

    function notionNetworkCollectContext(captures) {
        const blockIds = new Set();
        let spaceId = '';

        const scanBlockIds = value => {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value)) {
                for (const row of value) scanBlockIds(row);
                return;
            }
            for (const [key, child] of Object.entries(value)) {
                if (/^blockIds$/i.test(key) && Array.isArray(child)) {
                    for (const id of child) {
                        if (typeof id === 'string' && id.length >= 30) blockIds.add(id);
                    }
                } else if (
                    key === 'spaceId' &&
                    !spaceId &&
                    typeof child === 'string' &&
                    child.length >= 20
                ) {
                    spaceId = child;
                } else if (child && typeof child === 'object') {
                    scanBlockIds(child);
                }
            }
        };

        for (const capture of captures || []) {
            const parsed = notionNetworkParseJson(capture?.responseText);
            if (!parsed) continue;
            scanBlockIds(parsed);

            const blockMap = parsed?.recordMap?.block;
            if (!blockMap || typeof blockMap !== 'object') continue;

            for (const [id, record] of Object.entries(blockMap)) {
                const value = notionNetworkUnwrapRecord(record);
                if (!value) continue;

                const type = String(value.type || '');
                const parentTable = String(value.parent_table || value.parentTable || '');
                if (
                    type === 'page' ||
                    parentTable === 'collection' ||
                    parentTable === 'collection_view'
                ) {
                    blockIds.add(id);
                }

                if (!spaceId) {
                    spaceId =
                        String(record?.spaceId || '') ||
                        String(record?.value?.spaceId || '') ||
                        String(value.space_id || value.spaceId || '');
                }
            }
        }

        return {
            blockIds: [...blockIds].filter(Boolean).slice(0, 220),
            spaceId: String(spaceId || '')
        };
    }

    function notionNetworkGmPostJson(url, payload, context = '') {
        if (!GM_XHR) {
            return Promise.reject(new Error('GM_xmlhttpRequest를 사용할 수 없습니다.'));
        }

        const requestBody = JSON.stringify(payload || {});
        return new Promise((resolve, reject) => {
            GM_XHR({
                method: 'POST',
                url,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                data: requestBody,
                timeout: 12000,
                onload: response => {
                    const responseText = String(response?.responseText || '');
                    if (response.status >= 200 && response.status < 300) {
                        let data = {};
                        try {
                            data = responseText ? JSON.parse(responseText) : {};
                        } catch (_) {}
                        resolve({
                            data,
                            responseText,
                            requestBody,
                            status: response.status,
                            url
                        });
                    } else {
                        const error = new Error(
                            `${context || 'Notion 내부 API'} HTTP ${response.status}`
                        );
                        error.status = response.status;
                        error.responseText = responseText;
                        reject(error);
                    }
                },
                onerror: () => reject(new Error(`${context || 'Notion 내부 API'} 네트워크 오류`)),
                ontimeout: () => reject(new Error(`${context || 'Notion 내부 API'} 시간 초과`))
            });
        });
    }

    async function notionNetworkExpandCapturedRows() {
        let job = notionCrawlerJobRead();
        if (!job || job.status !== 'running' || job.mode !== 'network-intercept') {
            return { rows: 0, pageChunks: 0, readablePages: [] };
        }

        const initialCaptures = Array.isArray(job.captures) ? [...job.captures] : [];
        const queryState =
            job.queryCollection && typeof job.queryCollection === 'object'
                ? job.queryCollection
                : null;
        const targetDatabase =
            job.targetDatabase && typeof job.targetDatabase === 'object'
                ? job.targetDatabase
                : null;
        const fallbackContext = notionNetworkCollectContext(initialCaptures);

        let origin = '';
        try {
            origin = new URL(job.rootUrl || location.href).origin;
        } catch (_) {
            origin = location.origin;
        }

        const cloneJson = value => {
            try { return JSON.parse(JSON.stringify(value)); }
            catch (_) { return null; }
        };

        const propertyNames = {
            ...(queryState?.propertyNames && typeof queryState.propertyNames === 'object'
                ? queryState.propertyNames
                : {})
        };
        const rowImageRefs = {
            ...(queryState?.rowImageRefs && typeof queryState.rowImageRefs === 'object'
                ? queryState.rowImageRefs
                : {})
        };
        let imagePropertyIds = [
            ...new Set(
                Array.isArray(queryState?.imagePropertyIds)
                    ? queryState.imagePropertyIds
                    : []
            )
        ];
        const blockRecords = {};
        if (!targetDatabase) {
            for (const row of Array.isArray(queryState?.rowRecords)
                ? queryState.rowRecords
                : []) {
                if (row?.id) blockRecords[row.id] = row;
            }
        }

        // Also compact whatever useful blocks happened to be captured before
        // expansion (for example syncRecordValuesSpaceInitial responses).
        for (const capture of initialCaptures) {
            const parsed = notionNetworkParseJson(capture?.responseText);
            if (!parsed) continue;
            notionNetworkMergeCompactBlocks(
                blockRecords,
                notionNetworkExtractCompactBlocks(parsed)
            );
            Object.assign(propertyNames, notionNetworkExtractPropertyNames(parsed));
        }

        const rowIds = new Set(
            (
                targetDatabase
                    ? []
                    : (
                        Array.isArray(queryState?.blockIds) && queryState.blockIds.length
                            ? queryState.blockIds
                            : fallbackContext.blockIds
                    )
            ).filter(Boolean)
        );
        for (const id of Object.keys(blockRecords)) {
            const block = blockRecords[id];
            if (
                block?.type === 'page' &&
                (block?.parent_table === 'collection' || rowIds.has(id))
            ) rowIds.add(id);
        }

        let sizeHint = Math.max(Number(queryState?.sizeHint || 0), rowIds.size);
        let fullQueryWorked = false;

        const mergeQueryResult = resultData => {
            if (!resultData || typeof resultData !== 'object') return 0;
            const group =
                resultData?.result?.reducerResults?.collection_group_results ||
                null;
            const ids = Array.isArray(group?.blockIds)
                ? group.blockIds.filter(id => typeof id === 'string' && id.length >= 30)
                : [];
            for (const id of ids) rowIds.add(id);

            imagePropertyIds = [
                ...new Set([
                    ...imagePropertyIds,
                    ...notionNetworkExtractImagePropertyIds(resultData)
                ])
            ];

            const incoming = notionNetworkExtractCompactBlocks(resultData, ids);
            for (const [id, row] of Object.entries(incoming)) {
                const attachment = notionNetworkImageAttachmentFromRow(
                    row,
                    imagePropertyIds
                );
                if (attachment) {
                    rowImageRefs[id] = {
                        attachment,
                        spaceId: String(row?.space_id || '')
                    };
                }
            }

            notionNetworkMergeCompactBlocks(blockRecords, incoming);
            Object.assign(propertyNames, notionNetworkExtractPropertyNames(resultData));
            sizeHint = Math.max(
                sizeHint,
                Number(resultData?.result?.sizeHint || 0),
                rowIds.size
            );
            return ids.length;
        };

        // 1) Replay the exact browser request once.  This uses the current
        // request shape (collectionViewBlock / isFullScreen / etc.) instead of
        // guessing from an old unofficial API schema.  It normally gives us
        // the same initial rows but also verifies the endpoint is callable.
        if (!targetDatabase && queryState?.requestPayload && queryState?.url) {
            try {
                const endpoint = new URL(queryState.url, origin).href;
                const result = await notionNetworkGmPostJson(
                    endpoint,
                    cloneJson(queryState.requestPayload) || {},
                    'queryCollection replay'
                );
                mergeQueryResult(result?.data);
            } catch (error) {
                console.warn(`[${APP_NAME}] exact queryCollection replay skipped`, error);
            }
        }

        // 2) Best-effort legacy expanded query.  Some public Notion cells still
        // accept this shape and return all rows when the reducer limit is raised.
        // Failure is harmless: the captured initial rows remain usable.
        if (
            !targetDatabase &&
            queryState?.hasMore &&
            queryState?.compiledRequest &&
            typeof queryState.compiledRequest === 'object'
        ) {
            const compiled = cloneJson(queryState.compiledRequest);
            const source = compiled?.source;
            const collectionView = compiled?.collectionView;
            const loader = compiled?.loader;
            if (source?.id && collectionView?.id && loader) {
                const expandedLoader = cloneJson(loader) || {};
                expandedLoader.type = expandedLoader.type || 'reducer';
                expandedLoader.reducers =
                    expandedLoader.reducers && typeof expandedLoader.reducers === 'object'
                        ? expandedLoader.reducers
                        : {};
                for (const reducer of Object.values(expandedLoader.reducers)) {
                    if (reducer && typeof reducer === 'object' && String(reducer.type || '') === 'results') {
                        reducer.limit = 9999;
                        if ('loadContentCover' in reducer) reducer.loadContentCover = false;
                    }
                }
                if (!expandedLoader.reducers.collection_group_results) {
                    expandedLoader.reducers.collection_group_results = {
                        type: 'results',
                        limit: 9999,
                        loadContentCover: false
                    };
                }
                const payload = {
                    collection: {
                        id: source.id,
                        ...(source.spaceId ? { spaceId: source.spaceId } : {})
                    },
                    collectionView: {
                        id: collectionView.id,
                        ...(collectionView.spaceId ? { spaceId: collectionView.spaceId } : {})
                    },
                    loader: expandedLoader
                };
                notionCrawlerJobWrite({
                    ...job,
                    message:
                        `Notion DB row 목록 확인 중… ${rowIds.size}` +
                        (sizeHint ? `/${sizeHint}` : '')
                });
                try {
                    const result = await notionNetworkGmPostJson(
                        `${origin}/api/v3/queryCollection?src=initial_load`,
                        payload,
                        'queryCollection expanded'
                    );
                    const before = rowIds.size;
                    const count = mergeQueryResult(result?.data);
                    fullQueryWorked = count > 0 && rowIds.size > before;
                } catch (error) {
                    console.warn(`[${APP_NAME}] expanded queryCollection skipped`, error);
                }
            }
        }

        // Explicit external DB target: query exactly the selected collection view.
        if (targetDatabase?.blockId && targetDatabase?.viewId) {
            notionCrawlerJobWrite({
                ...(notionCrawlerJobRead() || job),
                message: `“${targetDatabase.name || '외부 DB'}” row 목록 불러오는 중…`
            });
            try {
                const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Seoul';
                const directPayload = {
                    collectionView: {
                        id: String(targetDatabase.viewId),
                        ...(targetDatabase.spaceId ? { spaceId: String(targetDatabase.spaceId) } : {})
                    },
                    clientType: 'notion_app',
                    collectionViewBlock: {
                        id: String(targetDatabase.blockId),
                        ...(targetDatabase.spaceId ? { spaceId: String(targetDatabase.spaceId) } : {})
                    },
                    isFullScreen: true,
                    isMobile: false,
                    userTimeZone: timeZone
                };
                const result = await notionNetworkGmPostJson(
                    `${origin}/api/v3/queryCollection?src=initial_load`,
                    directPayload,
                    'queryCollection selected external DB'
                );
                const recovered = mergeQueryResult(result?.data);
                if (recovered) {
                    fullQueryWorked = true;
                    notionCrawlerJobWrite({
                        ...(notionCrawlerJobRead() || job),
                        message: `“${targetDatabase.name || '외부 DB'}” row ${rowIds.size}` + (sizeHint ? `/${sizeHint}` : '')
                    });
                }
            } catch (error) {
                console.warn(`[${APP_NAME}] selected external DB query failed`, error);
            }
        }

        // If the userscript missed Notion's initial queryCollection request
        // (this can happen depending on document-start timing / browser cache),
        // reconstruct that exact public initial-load request from the URL.
        // This removes the race where we captured 10+ API responses but missed
        // the single response that contains the database row list.
        if (!rowIds.size && !targetDatabase) {
            const idsFromUrl = notionNetworkIdsFromPublicUrl(job.rootUrl || location.href);
            if (idsFromUrl.pageId && idsFromUrl.viewId) {
                notionCrawlerJobWrite({
                    ...(notionCrawlerJobRead() || job),
                    message: 'Notion DB row 목록 직접 복구 중…'
                });
                try {
                    const timeZone =
                        Intl.DateTimeFormat().resolvedOptions().timeZone ||
                        'Asia/Seoul';
                    const directPayload = {
                        collectionView: { id: idsFromUrl.viewId },
                        clientType: 'notion_app',
                        collectionViewBlock: { id: idsFromUrl.pageId },
                        isFullScreen: true,
                        isMobile: false,
                        userTimeZone: timeZone
                    };
                    const result = await notionNetworkGmPostJson(
                        `${origin}/api/v3/queryCollection?src=initial_load`,
                        directPayload,
                        'queryCollection direct recovery'
                    );
                    const recovered = mergeQueryResult(result?.data);
                    if (recovered) {
                        fullQueryWorked = true;
                        notionCrawlerJobWrite({
                            ...(notionCrawlerJobRead() || job),
                            message:
                                `Notion DB row 목록 직접 복구 완료 · ${rowIds.size}` +
                                (sizeHint ? `/${sizeHint}` : '')
                        });
                    }
                } catch (error) {
                    console.warn(`[${APP_NAME}] direct queryCollection recovery failed`, error);
                }
            }
        }

        const pageIds = [...rowIds].filter(Boolean).slice(0, 500);
        if (!pageIds.length) {
            const readablePages = notionNetworkBuildReadablePages(
                job.rootUrl || location.href,
                initialCaptures
            );
            notionCrawlerJobWrite({
                ...job,
                expanded: true,
                readablePages,
                message:
                    `Notion 내부 API 응답 ${initialCaptures.length}개 확보 · ` +
                    `queryCollection row ID 없음 · 복원 ${readablePages.length}개`
            });
            return { rows: 0, pageChunks: 0, readablePages };
        }

        // In the real queryCollection response each row page is present, but its
        // `content` array points at child block ids which are NOT included in
        // recordMap.  loadCachedPageChunkV2 on a collection row is unreliable.
        // Notion itself resolves those pointers with syncRecordValues*, so do
        // the same directly and recursively.
        let spaceId =
            String(queryState?.compiledRequest?.source?.spaceId || '') ||
            String(queryState?.compiledRequest?.collectionView?.spaceId || '') ||
            String(fallbackContext.spaceId || '');
        if (!spaceId) {
            for (const block of Object.values(blockRecords)) {
                if (block?.space_id) {
                    spaceId = String(block.space_id);
                    break;
                }
            }
        }

        let syncRequests = 0;
        let syncedBlocks = 0;
        // Do NOT mark a child as completed before Notion actually returns it.
        // The old code did that, so one transient timeout permanently skipped
        // the entire batch and made expansion stop at a random point.
        const completedIds = new Set();
        const attemptCounts = new Map();
        const MAX_BLOCK_ATTEMPTS = 4;
        const SYNC_BATCH_SIZE = 36;

        const mergeSyncData = data => {
            const compact = notionNetworkExtractCompactBlocks(data);
            let added = 0;
            const returnedIds = [];
            for (const [id, block] of Object.entries(compact)) {
                returnedIds.push(id);
                if (!blockRecords[id]) added += 1;
                blockRecords[id] = notionNetworkMergeCompactBlock(blockRecords[id], block);
                completedIds.add(id);
                if (!spaceId && block?.space_id) spaceId = String(block.space_id);
            }
            Object.assign(propertyNames, notionNetworkExtractPropertyNames(data));
            syncedBlocks += added;
            return { added, returnedIds };
        };

        const syncBatch = async ids => {
            if (!ids.length || !spaceId) return { added: 0, returnedIds: [] };
            const payload = {
                requests: ids.map(id => ({
                    pointer: {
                        table: 'block',
                        id,
                        spaceId
                    },
                    version: -1
                }))
            };
            const endpoints = [
                `${origin}/api/v3/syncRecordValues`,
                'https://www.notion.so/api/v3/syncRecordValues'
            ];
            let lastError = null;

            // Internal Notion endpoints are occasionally flaky. Retry the SAME
            // unresolved ids with backoff instead of discarding them forever.
            for (let attempt = 0; attempt < 3; attempt++) {
                for (const endpoint of [...new Set(endpoints)]) {
                    try {
                        const result = await notionNetworkGmPostJson(
                            endpoint,
                            payload,
                            'syncRecordValues'
                        );
                        syncRequests += 1;
                        const merged = mergeSyncData(result?.data);
                        if (result?.data?.recordMap?.block) return merged;
                    } catch (error) {
                        lastError = error;
                    }
                }
                if (attempt < 2) await sleepMs(350 * (2 ** attempt));
            }

            for (const id of ids) {
                attemptCounts.set(id, (attemptCounts.get(id) || 0) + 1);
            }
            if (lastError) throw lastError;
            return { added: 0, returnedIds: [] };
        };

        if (spaceId) {
            for (let round = 0; round < 14; round++) {
                const missingSet = new Set();
                for (const block of Object.values(blockRecords)) {
                    for (const childId of Array.isArray(block?.content) ? block.content : []) {
                        if (
                            !blockRecords[childId] &&
                            !completedIds.has(childId) &&
                            (attemptCounts.get(childId) || 0) < MAX_BLOCK_ATTEMPTS
                        ) {
                            missingSet.add(childId);
                        }
                    }
                }
                const missing = [...missingSet];
                if (!missing.length) break;

                notionCrawlerJobWrite({
                    ...(notionCrawlerJobRead() || job),
                    message:
                        `Notion row 본문 block 직접 조회 중… ` +
                        `${Object.keys(blockRecords).length}개 확보 · 미해결 ${missing.length}개 · 재시도 ${round + 1}`
                });

                let roundAdded = 0;
                let roundReturned = 0;
                let roundFailures = 0;
                for (let i = 0; i < missing.length; i += SYNC_BATCH_SIZE) {
                    const batch = missing.slice(i, i + SYNC_BATCH_SIZE);
                    try {
                        const merged = await syncBatch(batch);
                        roundAdded += merged.added || 0;
                        roundReturned += merged.returnedIds?.length || 0;

                        // If Notion returned only part of a requested batch, only
                        // those returned ids are completed. The rest stay eligible
                        // for a later retry.
                        const returned = new Set(merged.returnedIds || []);
                        for (const id of batch) {
                            if (!returned.has(id) && !blockRecords[id]) {
                                attemptCounts.set(id, (attemptCounts.get(id) || 0) + 1);
                            }
                        }
                    } catch (error) {
                        roundFailures += 1;
                        console.warn(`[${APP_NAME}] syncRecordValues batch retry later`, error);
                    }

                    notionCrawlerJobWrite({
                        ...(notionCrawlerJobRead() || job),
                        message:
                            `Notion row 본문 block 직접 조회 중… ` +
                            `${Object.keys(blockRecords).length}개 확보 · ` +
                            `${Math.min(i + batch.length, missing.length)}/${missing.length}` +
                            (roundFailures ? ` · 실패 ${roundFailures}배치 재시도 예정` : '')
                    });

                    // Smaller batches + a modest pause are much more stable on
                    // public Notion than bursts of 100 records.
                    if (i + SYNC_BATCH_SIZE < missing.length) await sleepMs(260);
                }

                // New child blocks can reveal another generation of children.
                // Even when this round returned nothing, keep retrying unresolved
                // ids until their attempt budget is exhausted instead of stopping
                // the whole crawl immediately.
                if (!roundAdded && !roundReturned) await sleepMs(700);
            }
        }

        // Build the readable rows from the compact in-memory record map.  This
        // bypasses the old 620k response truncation entirely.
        const synthetic = notionNetworkSyntheticCapture(blockRecords, propertyNames);

        const attachExactRowImages = pages => {
            for (const page of pages || []) {
                const id = String(page?.id || '');
                if (!id) continue;
                const imageMeta = rowImageRefs[id];
                if (!imageMeta?.attachment) continue;
                const row = blockRecords[id];
                const spaceId =
                    String(imageMeta.spaceId || '') ||
                    String(row?.space_id || row?.spaceId || '');
                const exactUrl = notionNetworkPublicImageUrl(
                    job.rootUrl || location.href,
                    id,
                    spaceId,
                    {},
                    String(imageMeta.attachment)
                );
                if (exactUrl) page.imageUrl = exactUrl;
            }
            return pages;
        };

        let readablePages = attachExactRowImages(notionNetworkBuildReadablePages(
            job.rootUrl || location.href,
            [synthetic]
        )).filter(page => {
            const text = String(page?.text || '');
            // A title + page id only is not a useful prompt page.
            return /\[(?:code|text|heading|bulleted_list|numbered_list|toggle|quote|callout|block)\]|PROPERTY\s+/i.test(text);
        });

        // Last-resort API-only fallback: if syncRecordValues yielded no child
        // text, try loadCachedPageChunkV2 on a limited number of rows.  This is
        // still internal-API-only and never reads DOM text.
        let pageChunkSuccess = 0;
        if (!readablePages.length) {
            const extraCaptures = [];
            const retryIds = pageIds.slice(0, 60);
            let cursor = 0;
            const workerCount = Math.min(4, retryIds.length || 1);
            const worker = async () => {
                while (true) {
                    const index = cursor++;
                    if (index >= retryIds.length) return;
                    const pageId = retryIds[index];
                    try {
                        const result = await notionNetworkGmPostJson(
                            `${origin}/api/v3/loadCachedPageChunkV2`,
                            {
                                page: { id: pageId },
                                limit: 100,
                                cursor: { stack: [] },
                                chunkNumber: 0,
                                verticalColumns: false
                            },
                            'loadCachedPageChunkV2'
                        );
                        pageChunkSuccess += 1;
                        extraCaptures.push({
                            url: result.url || '',
                            method: 'POST',
                            status: result.status || 200,
                            requestBody: result.requestBody || '',
                            responseText: String(result.responseText || ''),
                            priority: 95,
                            capturedAt: Date.now()
                        });
                    } catch (_) {}
                }
            };
            await Promise.all(Array.from({ length: workerCount }, () => worker()));
            if (extraCaptures.length) {
                readablePages = attachExactRowImages(notionNetworkBuildReadablePages(
                    job.rootUrl || location.href,
                    [synthetic, ...extraCaptures]
                )).filter(page => {
                    const text = String(page?.text || '');
                    return /\[(?:code|text|heading|bulleted_list|numbered_list|toggle|quote|callout|block)\]|PROPERTY\s+/i.test(text);
                });
            }
        }

        job = notionCrawlerJobRead();
        if (job && job.status === 'running') {
            const childRefs = new Set();
            for (const id of pageIds) {
                for (const childId of blockRecords[id]?.content || []) childRefs.add(childId);
            }
            notionCrawlerJobWrite({
                ...job,
                expanded: true,
                readablePages,
                queryCollection: {
                    ...(job.queryCollection || {}),
                    blockIds: pageIds,
                    sizeHint,
                    imagePropertyIds,
                    rowImageRefs,
                    expandedAllRows: fullQueryWorked && pageIds.length >= sizeHint
                },
                message:
                    `Notion 내부 API 확장 완료 · row ${pageIds.length}` +
                    (sizeHint ? `/${sizeHint}` : '') +
                    ` · 자식 block ${syncedBlocks}개` +
                    ` · 복원 ${readablePages.length}개` +
                    ` · 이미지 ${readablePages.filter(page => page?.imageUrl).length}개`
            });
        }

        return {
            rows: pageIds.length,
            pageChunks: syncRequests + pageChunkSuccess,
            readablePages
        };
    }

    function notionNetworkInternalRichTextToPlain(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);

        if (Array.isArray(value)) {
            // Notion 내부 rich text는 보통 [["text", [...decorations]], ...] 형태다.
            if (
                value.length &&
                value.every(row => Array.isArray(row)) &&
                value.some(row => typeof row?.[0] === 'string')
            ) {
                return value
                    .map(row => typeof row?.[0] === 'string' ? row[0] : '')
                    .join('');
            }

            return value
                .map(row => notionNetworkInternalRichTextToPlain(row))
                .filter(Boolean)
                .join(' ');
        }

        if (typeof value === 'object') {
            return Object.values(value)
                .map(row => notionNetworkInternalRichTextToPlain(row))
                .filter(Boolean)
                .join(' ');
        }

        return '';
    }

    function notionNetworkBuildReadablePages(rootUrl, captures) {
        const blocks = new Map();
        const propertyNames = new Map();

        for (const capture of captures || []) {
            const parsed = notionNetworkParseJson(capture?.responseText);
            if (!parsed) continue;

            const collectionMap = parsed?.recordMap?.collection;
            if (collectionMap && typeof collectionMap === 'object') {
                for (const record of Object.values(collectionMap)) {
                    const value = notionNetworkUnwrapRecord(record);
                    const schema = value?.schema;
                    if (!schema || typeof schema !== 'object') continue;
                    for (const [propertyId, definition] of Object.entries(schema)) {
                        const name = String(definition?.name || definition?.id || propertyId || '').trim();
                        if (name) propertyNames.set(propertyId, name);
                    }
                }
            }

            const blockMap = parsed?.recordMap?.block;
            if (!blockMap || typeof blockMap !== 'object') continue;
            for (const [id, record] of Object.entries(blockMap)) {
                const value = notionNetworkUnwrapRecord(record);
                if (!value) continue;
                blocks.set(id, {
                    ...value,
                    __id: id
                });
            }
        }

        const cleanText = value =>
            notionNetworkInternalRichTextToPlain(value)
                .replace(/\u0000/g, '')
                .replace(/[ \t]+\n/g, '\n')
                .trim();

        const pageUrlForId = id => {
            try {
                const url = new URL(rootUrl);
                url.search = '';
                url.hash = '';
                const compactId = String(id || '').replace(/-/g, '');
                return url.hostname === 'app.notion.com'
                    ? `${url.origin}/p/${compactId}`
                    : `${url.origin}/${compactId}`;
            } catch (_) {
                return rootUrl;
            }
        };

        const blockText = block => {
            const props = block?.properties || {};
            return cleanText(
                props.title ??
                props.caption ??
                props.source ??
                ''
            );
        };

        const walkChildren = (id, lines, seen, depth = 0) => {
            if (!id || seen.has(id) || depth > 10 || lines.join('\n').length > 65000) return;
            seen.add(id);
            const block = blocks.get(id);
            if (!block) return;

            const type = String(block.type || 'block');
            const text = blockText(block);
            if (text) {
                const prefix =
                    type === 'code' ? '[code]' :
                    /header|heading/.test(type) ? '[heading]' :
                    type === 'page' ? '[page]' :
                    `[${type}]`;
                lines.push(`${prefix} ${text}`);
            }

            for (const childId of block.content || []) {
                walkChildren(childId, lines, seen, depth + 1);
            }
        };

        const pages = [];
        for (const [id, page] of blocks.entries()) {
            if (String(page.type || '') !== 'page') continue;

            const lines = [];
            const title = blockText(page) || 'Notion page';
            lines.push(`PAGE TITLE: ${title}`);
            lines.push(`PAGE ID: ${id}`);

            const props = page.properties || {};
            for (const [propertyId, rawValue] of Object.entries(props)) {
                if (propertyId === 'title') continue;
                const text = cleanText(rawValue);
                if (!text) continue;
                const name = propertyNames.get(propertyId) || propertyId;
                lines.push(`PROPERTY ${name}: ${text}`);
            }

            for (const childId of page.content || []) {
                walkChildren(childId, lines, new Set([id]), 0);
            }

            const text = lines.join('\n').trim();
            if (text.length < 20) continue;

            const imageUrl = notionNetworkPublicImageUrl(
                rootUrl,
                id,
                String(page.space_id || page.spaceId || ''),
                props,
                String(page.attachment_ref || '')
            );

            pages.push({
                id,
                url: pageUrlForId(id),
                title,
                text: text.slice(0, 70000),
                linkCount: 0,
                imageUrl
            });

            if (pages.length >= 220) break;
        }

        // 드물게 row block이 type=page가 아닌 응답 포맷도 있으므로,
        // page를 하나도 복원하지 못했을 때는 모든 텍스트 block을 진단용 한 페이지로 묶는다.
        if (!pages.length && blocks.size) {
            const lines = [];
            for (const [id, block] of blocks.entries()) {
                const text = blockText(block);
                if (!text) continue;
                lines.push(`[${block.type || 'block'} ${id}] ${text}`);
                if (lines.join('\n').length > 100000) break;
            }
            if (lines.length) {
                pages.push({
                    url: rootUrl,
                    title: 'Notion internal blocks',
                    text: lines.join('\n').slice(0, 100000),
                    linkCount: 0
                });
            }
        }

        return pages;
    }

    async function runNotionNetworkInterceptorHelper() {
        let job = notionCrawlerJobRead();
        if (!job || job.status !== 'running' || job.mode !== 'network-intercept') return;

        installNotionNetworkInterceptor();
        const guestMode = notionExternalAccessMode(job.rootUrl) === 'guest';
        notionCrawlerJobWrite({
            ...job,
            message: guestMode
                ? '게스트 Notion 로그인 세션으로 내부 API 요청 대기 중…'
                : 'Notion 내부 API 요청 대기 중…'
        });

        const started = Date.now();
        let expansionStarted = false;

        while (Date.now() - started < NOTION_NETWORK_MAX_WAIT_MS + 45000) {
            await sleepMs(300);
            job = notionCrawlerJobRead();
            if (!job || job.status !== 'running' || job.mode !== 'network-intercept') return;

            const captures = Array.isArray(job.captures) ? job.captures : [];
            const lastCaptureAt = Number(job.lastCaptureAt || 0);
            const elapsed = Date.now() - started;
            const idle = lastCaptureAt ? Date.now() - lastCaptureAt : Infinity;

            const queryRows =
                Array.isArray(job?.queryCollection?.blockIds)
                    ? job.queryCollection.blockIds.length
                    : 0;
            const queryReady =
                queryRows > 0 &&
                elapsed >= 3000 &&
                idle >= 1600;
            const timeoutReady =
                elapsed >= 12000 &&
                idle >= 3000;

            if (
                !expansionStarted &&
                captures.length &&
                (queryReady || timeoutReady)
            ) {
                expansionStarted = true;
                try {
                    await notionNetworkExpandCapturedRows();
                } catch (error) {
                    console.warn(`[${APP_NAME}] Notion internal API expansion failed`, error);
                }

                job = notionCrawlerJobRead();
                if (!job || job.status !== 'running') return;
                const finalCaptures = Array.isArray(job.captures) ? job.captures : [];
                const readablePages = Array.isArray(job.readablePages) ? job.readablePages : [];
                notionCrawlerJobWrite({
                    ...job,
                    status: 'done',
                    message:
                        `Notion 내부 API 완료 · 초기 응답 ${finalCaptures.length}개 · ` +
                        `query row ${job?.queryCollection?.blockIds?.length || 0}개 · ` +
                        `row/page ${readablePages.length}개 복원`
                });
                return;
            }
        }

        job = notionCrawlerJobRead();
        const captures = Array.isArray(job?.captures) ? job.captures : [];
        if (captures.length) {
            if (!expansionStarted) {
                try {
                    await notionNetworkExpandCapturedRows();
                } catch (_) {}
                job = notionCrawlerJobRead() || job;
            }
            const finalCaptures = Array.isArray(job?.captures) ? job.captures : captures;
            const readablePages = Array.isArray(job?.readablePages) ? job.readablePages : [];
            notionCrawlerJobWrite({
                ...job,
                status: 'done',
                message:
                    `Notion 내부 API 완료 · 초기 응답 ${finalCaptures.length}개 · ` +
                    `query row ${job?.queryCollection?.blockIds?.length || 0}개 · ` +
                    `row/page ${readablePages.length}개 복원`
            });
            return;
        }

        notionCrawlerJobWrite({
            ...job,
            status: 'error',
            error:
                notionExternalAccessMode(job.rootUrl) === 'guest'
                    ? '게스트 Notion 내부 API 응답을 잡지 못했습니다. 이 브라우저에서 해당 Notion 페이지가 로그인된 상태로 열리는지 확인해주세요.'
                    : '이 Notion 페이지에서 읽을 수 있는 내부 API 응답을 잡지 못했습니다.'
        });
    }


    async function waitForNotionRenderedDom() {
        if (document.readyState === 'loading') {
            await new Promise(resolve => {
                document.addEventListener('DOMContentLoaded', resolve, { once: true });
            });
        }

        const started = Date.now();
        let stableRounds = 0;
        let previousSignature = '';

        while (Date.now() - started < NOTION_BROWSER_PAGE_SETTLE_MS) {
            const body = document.body;
            const textLength = String(body?.innerText || '').trim().length;
            const anchorCount = document.querySelectorAll('a[href]').length;
            const signature = `${textLength}:${anchorCount}`;

            if (textLength >= 30 && signature === previousSignature) {
                stableRounds += 1;
            } else {
                stableRounds = 0;
            }

            previousSignature = signature;

            if (stableRounds >= 3) break;
            await sleepMs(500);
        }

        try {
            const maxY = Math.max(
                document.body?.scrollHeight || 0,
                document.documentElement?.scrollHeight || 0
            );
            if (maxY > innerHeight * 1.5) {
                scrollTo(0, maxY);
                await sleepMs(700);
                scrollTo(0, 0);
                await sleepMs(350);
            }
        } catch (_) {}
    }

    function extractRenderedNotionLinks(currentUrl, rootUrl) {
        const candidates = [];

        const pushCandidate = (raw, title = '') => {
            const resolved = cleanDiscoveredUrl(raw, currentUrl);
            if (!resolved) return;
            if (!isNotionUrl(resolved)) return;
            if (!isLikelyNotionChildPage(resolved, rootUrl)) return;
            if (notionCrawlerCurrentKey(resolved) === notionCrawlerCurrentKey(currentUrl)) return;

            candidates.push({
                url: resolved,
                title: String(title || '').trim().slice(0, 180)
            });
        };

        for (const anchor of document.querySelectorAll('a[href]')) {
            pushCandidate(
                anchor.getAttribute('href'),
                anchor.textContent || anchor.getAttribute('aria-label') || ''
            );
        }

        for (const el of document.querySelectorAll('[role="link"], [data-href], [data-url]')) {
            const raw =
                el.getAttribute('href') ||
                el.getAttribute('data-href') ||
                el.getAttribute('data-url');

            if (raw) {
                pushCandidate(
                    raw,
                    el.textContent || el.getAttribute('aria-label') || ''
                );
            }
        }

        try {
            const html = document.documentElement?.innerHTML || '';
            const rootHost = new URL(rootUrl).hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const absoluteRe = new RegExp(
                `https?:\\/\\/${rootHost}\\/[^\\s"'<>\\\\]{1,260}`,
                'gi'
            );
            const relativeRe = /["'](\/[^"'<>]{0,220}[0-9a-f]{32}[^"'<>]{0,80})["']/gi;

            for (const match of html.match(absoluteRe) || []) {
                pushCandidate(match, '');
            }

            let m;
            let guard = 0;
            while ((m = relativeRe.exec(html)) && guard < 250) {
                guard += 1;
                pushCandidate(m[1], '');
            }
        } catch (_) {}

        const map = new Map();
        for (const item of candidates) {
            const key = notionCrawlerCurrentKey(item.url);
            if (!key || map.has(key)) continue;
            map.set(key, item);
        }

        return [...map.values()];
    }

    function extractRenderedNotionText() {
        const preferred =
            document.querySelector('main') ||
            document.querySelector('[role="main"]') ||
            document.body;

        let text = String(preferred?.innerText || document.body?.innerText || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
            .trim();

        text = text.replace(/^(?:NAI Archive|NAI Concept Loader)[\s\S]{0,250}?\n\n/i, '');

        return text.slice(0, 140000);
    }

    async function runNotionRenderedCrawlerHelper() {
        let job = notionCrawlerJobRead();
        if (!job || job.status !== 'running') return;

        await waitForNotionRenderedDom();

        job = notionCrawlerJobRead();
        if (!job || job.status !== 'running') return;

        const currentUrl = cleanDiscoveredUrl(location.href, job.rootUrl) || location.href;
        const currentKey = notionCrawlerCurrentKey(currentUrl);
        const currentDepth = Number(job.current?.depth || 0);

        notionCrawlerBadge(
            `${APP_NAME}\nNotion 실제 화면 수집 중\n` +
            `${(job.visited || []).length + 1}/${NOTION_MAX_PAGES} · 깊이 ${currentDepth}/${NOTION_MAX_DEPTH}`
        );

        const text = extractRenderedNotionText();
        const links = extractRenderedNotionLinks(currentUrl, job.rootUrl);
        const title = String(document.title || '').replace(/\s*[|–—-]\s*Notion\s*$/i, '').trim();

        const visited = new Set(job.visited || []);
        const queued = new Set(
            (job.queue || []).map(item => notionCrawlerCurrentKey(item.url))
        );

        if (!visited.has(currentKey)) {
            visited.add(currentKey);
            job.pages = [...(job.pages || []), {
                url: currentUrl,
                title,
                text,
                depth: currentDepth,
                linkCount: links.length
            }];
        }

        if (currentDepth < NOTION_MAX_DEPTH) {
            for (const link of links) {
                if ((job.pages || []).length + (job.queue || []).length >= NOTION_MAX_PAGES) {
                    break;
                }

                const key = notionCrawlerCurrentKey(link.url);
                if (!key || visited.has(key) || queued.has(key)) continue;

                queued.add(key);
                job.queue = [...(job.queue || []), {
                    url: link.url,
                    title: link.title || '',
                    depth: currentDepth + 1
                }];
            }
        }

        job.visited = [...visited];
        job.lastPage = {
            url: currentUrl,
            title,
            depth: currentDepth,
            textLength: text.length,
            childLinks: links.length
        };

        const next = (job.queue || []).shift();

        if (next) {
            job.current = next;
            job.message =
                `Notion 실제 화면 수집 ${(job.pages || []).length}/${NOTION_MAX_PAGES}\n` +
                `${title || currentUrl}\n하위 링크 ${links.length}개 발견`;
            notionCrawlerJobWrite(job);

            await sleepMs(200);
            location.replace(next.url);
            return;
        }

        job.status = 'done';
        job.current = null;
        job.message =
            `Notion 실제 화면 수집 완료 · ${(job.pages || []).length}개 페이지`;
        notionCrawlerJobWrite(job);
        notionCrawlerBadge(job.message + '\n이 탭은 자동으로 닫힙니다.');

        await sleepMs(500);
        try { window.close(); } catch (_) {}
    }

    function buildRenderedNotionBatchPrompt(rootUrl, pages, settings = {}) {
        const pagePayload = pages.map((page, index) => `
===== PAGE ${index + 1} START =====
URL: ${page.url}
TITLE: ${page.title || ''}
DEPTH: ${page.depth}

${String(page.text || '').slice(0, 60000)}
===== PAGE ${index + 1} END =====`).join('\n');

        return `
너는 NovelAI 이미지 생성용 공유 Prompt "세트"를 원문 그대로 추출하는 분석기다.
아래 내용은 사용자의 브라우저가 실제로 렌더링한 공개 Notion 페이지들의 텍스트다.
루트 URL: ${rootUrl}

가장 중요한 규칙:
1. 창작하지 말고 추출만 하라.
2. Prompt에 있는 태그를 추가/삭제/번역/재정렬/교정/요약하지 마라.
3. 쉼표, # 접두사, :: 가중치, 괄호/중괄호/대괄호, 순서를 원문 그대로 보존하라.
4. 원문에 의미 있는 줄바꿈이 있으면 문자열 내부에서도 그대로 보존하라.
5. 하나의 완성된 세트 안에 "공통 Prompt / Character 1 Prompt / Character 2 Prompt"가 있으면 절대로 3개 concept로 쪼개지 마라. 하나의 concept 안에 합쳐 구조만 분리하라.
6. "공통 Prompt", "Base Prompt", "Common Prompt", "Scene Prompt" 등 전체에 적용되는 Prompt는 tags에 넣어라.
7. "Character 1 Prompt", "Character 2 Prompt", "Character N Prompt"처럼 캐릭터가 명시된 영역만 characters 배열로 옮겨라.
8. 단순 줄바꿈/문단 분리는 Character Prompt의 증거가 아니다. 캐릭터 라벨이 없으면 tags 안에 원문 줄바꿈 그대로 보존하라.
9. 전체 "Negative Prompt", "Undesired Content", "UC", "Negative"는 negativeTags에 넣어라.
10. "Character N Negative Prompt", "Character N Undesired Content"는 해당 character의 negativePrompt에 넣어라.
11. characters 항목의 name은 가능하면 원문의 "Character N" 라벨을 그대로 사용하라.
12. 공통 Prompt가 없고 Character Prompt만 있어도 concept 하나로 반환할 수 있다.
13. 페이지에 완전히 독립된 여러 프리셋/예시/세트가 명확히 있을 때만 concepts를 여러 개 반환하라.
14. 설명문, 목차, 사용법, 버튼명, 이미지 캡션, 해설 문장은 Prompt 태그에 넣지 마라.
15. 단, 해당 Prompt 세트 바로 위/아래 또는 같은 섹션에 작성자가 남긴 짧은 사용 팁/주의사항/추천 조합/수정 지시가 있으면 note에 보존하라.
16. note에는 PAGE에 실제 존재하는 문구만 사용하고 새 설명을 만들거나 추측하지 마라. 해당 세트와 무관한 잡담/긴 일반 설명은 제외하라.
17. 메모로 남길 내용이 없으면 note는 빈 문자열로 반환하라.
18. suggestedName은 실제 태그의 핵심 장면/용도/효과를 나타내는 짧고 구체적인 제목으로 만들어라.
19. suggestedName 앞에 "Nai 공유 태그 -", "NAI 공유 태그 -", "공유 태그 -", "Prompt -", "프롬프트 -", "태그 -" 같은 상투적인 접두어를 절대 붙이지 마라.
20. 페이지 제목을 기계적으로 복사하지 말고 태그 내용을 기준으로 "노트북 셀카", "피임 필수"처럼 간략하게 제안하라.
21. sourceUrl은 실제 태그가 나온 PAGE URL을 그대로 사용하라.
22. 태그가 없는 PAGE는 무시하라.
23. characters가 없으면 빈 배열 []로 반환하라.
24. JSON 하나만 출력하고 코드블록/설명은 금지한다.

반환 형식:
{
  "pageTitle": "전체 자료의 짧은 제목 또는 빈 문자열",
  "concepts": [
    {
      "suggestedName": "태그 내용을 나타내는 짧고 구체적인 제목",
      "sectionLabel": "원문의 세트/프리셋 라벨 또는 빈 문자열",
      "tags": "Base/Common/Positive Prompt. 없으면 빈 문자열",
      "negativeTags": "전체 Negative/Undesired Content. 없으면 빈 문자열",
      "characters": [
        {
          "name": "Character 1",
          "prompt": "해당 Character Prompt. 없으면 빈 문자열",
          "negativePrompt": "해당 Character Negative/Undesired Content. 없으면 빈 문자열"
        }
      ],
      "note": "해당 세트 주변의 작성자 사용 팁/주의사항 원문. 없으면 빈 문자열",
      "sourceUrl": "태그가 나온 PAGE URL",
      "sourcePageTitle": "해당 PAGE 제목"
    }
  ]
}


${pagePayload}
`.trim();
    }

    function parseRenderedNotionBatchJson(text, fallbackPages) {
        const parsed = parseLooseJsonObject(text);
        const rows = Array.isArray(parsed.concepts) ? parsed.concepts : [];
        const knownUrls = new Set(fallbackPages.map(page => page.url));

        return {
            pageTitle: String(parsed.pageTitle || '').trim(),
            concepts: rows.map((item, index) => {
                const tags = String(
                    item?.tags ??
                    item?.basePrompt ??
                    item?.prompt ??
                    item?.positivePrompt ??
                    ''
                ).trim();

                const negativeTags = String(
                    item?.negativeTags ??
                    item?.negativePrompt ??
                    item?.undesiredContent ??
                    ''
                ).trim();

                const characters = normalizeCharacterRows(
                    item?.characters ??
                    item?.characterPrompts ??
                    []
                );

                if (!tags && !negativeTags && !characters.length) {
                    return null;
                }

                let sourceUrl = String(item?.sourceUrl || '').trim();
                if (!knownUrls.has(sourceUrl)) {
                    sourceUrl = fallbackPages[0]?.url || '';
                }

                return {
                    id: createId(),
                    selected: true,
                    suggestedName:
                        String(item?.suggestedName || '').trim() ||
                        `컨셉 ${index + 1}`,
                    sectionLabel: String(
                        item?.sectionLabel ??
                        item?.setLabel ??
                        ''
                    ).trim(),
                    tags,
                    negativeTags,
                    characters,
                    note: String(item?.note || '').trim(),
                    sourceUrl,
                    sourcePageTitle: String(
                        item?.sourcePageTitle || ''
                    ).trim()
                };
            }).filter(Boolean)
        };
    }

    function splitRenderedNotionPagesIntoBatches(pages, maxChars = 115000, maxPages = Infinity) {
        const batches = [];
        let batch = [];
        let size = 0;

        for (const page of pages) {
            const text = String(page.text || '').trim();
            if (text.length < 20) continue;

            const estimated = Math.min(text.length, 60000) + 500;
            if (
                batch.length &&
                (size + estimated > maxChars || batch.length >= maxPages)
            ) {
                batches.push(batch);
                batch = [];
                size = 0;
            }

            batch.push(page);
            size += estimated;
        }

        if (batch.length) batches.push(batch);
        return batches;
    }


    function notionDirectPromptConcept(page) {
        const text = String(page?.text || '').replace(/\r\n?/g, '\n');
        if (!text.trim()) return null;

        const normalizeLabel = value => String(value || '')
            .toLowerCase()
            .replace(/[\s_\-–—:：()\[\]]+/g, ' ')
            .trim();
        const isNegative = label => /(?:negative|undesired|\buc\b|네거티브|부정)/i.test(label);
        const isBase = label => /(?:base|common|positive|scene|main|공통|메인|베이스|프롬프트|prompt)/i.test(label) && !/character|캐릭터/i.test(label);
        const charIndex = label => {
            const m = label.match(/(?:character|char|캐릭터)\s*(\d+)/i);
            return m ? Math.max(1, Number(m[1]) || 1) : 0;
        };

        let tags = '';
        let negativeTags = '';
        const characters = new Map();
        const unlabeledCodes = [];
        const categories = [];

        // Database properties are already rendered as PROPERTY Name: value.
        for (const match of text.matchAll(/^PROPERTY\s+([^:\n]+):\s*(.*)$/gmi)) {
            const name = normalizeLabel(match[1]);
            const value = String(match[2] || '').trim();
            if (!value) continue;
            if (/^(?:태그|tags?|category|categories|분류)$/.test(name)) {
                for (const row of value.split(/\s*,\s*|\s*\/\s*/).map(x => x.trim()).filter(Boolean)) {
                    if (!categories.includes(row)) categories.push(row);
                }
            } else if (/character|캐릭터/.test(name)) {
                const idx = charIndex(name) || 1;
                const row = characters.get(idx) || { name: `Character ${idx}`, prompt: '', negativePrompt: '' };
                if (isNegative(name)) row.negativePrompt = value;
                else row.prompt = value;
                characters.set(idx, row);
            } else if (isNegative(name)) {
                negativeTags = negativeTags || value;
            } else if (isBase(name)) {
                tags = tags || value;
            }
        }

        // Parse marker blocks created by notionNetworkBuildReadablePages.
        const marker = /^\[(code|heading|text|bulleted_list|numbered_list|toggle|quote|callout|page|block)\]\s*/gmi;
        const matches = [...text.matchAll(marker)];
        let lastHeading = '';
        for (let i = 0; i < matches.length; i++) {
            const m = matches[i];
            const type = String(m[1] || '').toLowerCase();
            const start = m.index + m[0].length;
            const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
            const body = text.slice(start, end)
                .replace(/^PROPERTY\s+[^:\n]+:.*$/gmi, '')
                .replace(/^PAGE (?:TITLE|ID):.*$/gmi, '')
                .trim();
            if (!body) continue;

            if (type === 'heading') {
                lastHeading = body.split('\n')[0].trim();
                continue;
            }
            if (type !== 'code') continue;

            const label = normalizeLabel(lastHeading);
            const idx = charIndex(label);
            if (idx) {
                const row = characters.get(idx) || { name: `Character ${idx}`, prompt: '', negativePrompt: '' };
                if (isNegative(label)) row.negativePrompt = body;
                else row.prompt = body;
                characters.set(idx, row);
            } else if (lastHeading && isNegative(label)) {
                negativeTags = negativeTags || body;
            } else if (lastHeading && isBase(label)) {
                tags = tags || body;
            } else {
                unlabeledCodes.push(body);
            }
        }

        // A single unlabeled code block is a strong signal for these shared
        // prompt libraries. Avoid AI entirely in that common case.
        if (!tags && !negativeTags && !characters.size && unlabeledCodes.length === 1) {
            tags = unlabeledCodes[0];
        }

        const characterRows = [...characters.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, row]) => row)
            .filter(row => row.prompt || row.negativePrompt);

        if (!tags && !negativeTags && !characterRows.length) return null;

        return {
            id: createId(),
            selected: true,
            suggestedName: String(page?.title || '').trim() || 'Prompt',
            sectionLabel: '',
            tags,
            negativeTags,
            characters: characterRows,
            note: '',
            categories,
            sourceUrl: String(page?.url || ''),
            sourcePageTitle: String(page?.title || '').trim(),
            _notionImageUrl: String(page?.imageUrl || '')
        };
    }

    function openNotionCrawlerTab(url, jobId) {
        if (typeof GM_openInTab === 'function') {
            const tab = GM_openInTab(url, {
                active: false,
                insert: true,
                setParent: true
            });

            if (tab) {
                return {
                    kind: 'gm',
                    raw: tab,
                    isClosed() {
                        try {
                            return Boolean(tab.closed);
                        } catch (_) {
                            return false;
                        }
                    },
                    close() {
                        try {
                            if (typeof tab.close === 'function') tab.close();
                        } catch (_) {}
                    }
                };
            }
        }

        const win = PAGE_WINDOW.open(
            url,
            `nai-notion-crawler-${jobId}`
        );

        if (!win) return null;

        return {
            kind: 'window',
            raw: win,
            isClosed() {
                try {
                    return Boolean(win.closed);
                } catch (_) {
                    return false;
                }
            },
            close() {
                try { win.close(); } catch (_) {}
            }
        };
    }

    async function collectNotionNetworkCaptures(rootUrl, onStatus = () => {}, targetDatabase = null) {
        const jobId = createId();
        const root = normalizeUrl(rootUrl);
        const job = {
            id: jobId,
            mode: 'network-intercept',
            status: 'running',
            rootUrl: root,
            targetDatabase:
                targetDatabase && targetDatabase.blockId && targetDatabase.viewId
                    ? {
                        id: String(targetDatabase.id || targetDatabase.collectionId || ''),
                        name: String(targetDatabase.name || ''),
                        collectionId: String(targetDatabase.collectionId || ''),
                        blockId: String(targetDatabase.blockId || ''),
                        viewId: String(targetDatabase.viewId || ''),
                        spaceId: String(targetDatabase.spaceId || '')
                    }
                    : null,
            captures: [],
            message: 'Notion 내부 API 가로채기 탭 여는 중…',
            startedAt: Date.now(),
            updatedAt: Date.now()
        };

        notionCrawlerJobWrite(job);
        const helperTab = openNotionCrawlerTab(root, jobId);
        if (!helperTab) {
            notionCrawlerJobWrite({ ...job, status: 'error', error: 'Notion 가로채기 탭을 열 수 없습니다.' });
            throw new Error('Notion 가로채기용 탭을 열 수 없습니다. novelai.net의 팝업을 허용해주세요.');
        }

        const started = Date.now();
        let lastMessage = '';
        try {
            while (Date.now() - started < NOTION_NETWORK_MAX_WAIT_MS + 90000) {
                await sleepMs(350);
                const current = notionCrawlerJobRead();
                if (!current || current.id !== jobId) throw new Error('Notion 가로채기 작업 정보가 사라졌습니다.');
                if (current.message && current.message !== lastMessage) {
                    lastMessage = current.message;
                    onStatus(current.message);
                }
                if (current.status === 'done') {
                    const captures = Array.isArray(current.captures) ? current.captures : [];
                    const readablePages = Array.isArray(current.readablePages)
                        ? current.readablePages
                        : [];
                    if (!captures.length && !readablePages.length) {
                        throw new Error('Notion 내부 API 응답을 잡지 못했습니다.');
                    }
                    return {
                        captures,
                        readablePages,
                        queryCollection:
                            current.queryCollection &&
                            typeof current.queryCollection === 'object'
                                ? current.queryCollection
                                : null,
                        message: String(current.message || '')
                    };
                }
                if (current.status === 'error') throw new Error(current.error || 'Notion 내부 API 가로채기 실패');
                if (helperTab.isClosed()) throw new Error('Notion 가로채기 탭이 완료 전에 닫혔습니다.');
            }
            throw new Error('Notion 내부 API 응답 대기 시간이 초과되었습니다.');
        } finally {
            GM_setValue(NOTION_BROWSER_JOB_KEY, null);
            helperTab.close();
        }
    }

    function buildNotionNetworkCapturePayload(rootUrl, captures) {
        const sorted = [...captures].sort((a, b) => (b.priority || 0) - (a.priority || 0));
        let remaining = 680000;
        const chunks = [];
        for (const capture of sorted) {
            if (remaining <= 0) break;
            const responseText = String(capture.responseText || '');
            if (!responseText) continue;
            const header = `\n===== NOTION API RESPONSE =====\nURL: ${capture.url}\nMETHOD: ${capture.method}\nSTATUS: ${capture.status}\nREQUEST: ${String(capture.requestBody || '').slice(0, 12000)}\nRESPONSE:\n`;
            const take = Math.max(0, Math.min(responseText.length, remaining - header.length));
            if (take <= 0) break;
            chunks.push(header + responseText.slice(0, take));
            remaining -= header.length + take;
        }
        return `Notion URL: ${rootUrl}\n아래 내용은 해당 Notion 페이지가 화면을 만들기 위해 실제로 받은 내부 API 응답 JSON이다. DOM 텍스트가 아니다.\n${chunks.join('\n')}`;
    }

    function notionNetworkExternalNavigationEntries(rootUrl, captures) {
        const blocks = new Map();
        const rootId = String(notionNetworkIdsFromPublicUrl(rootUrl).pageId || '');
        const plain = value =>
            notionNetworkInternalRichTextToPlain(value)
                .replace(/\u0000/g, '')
                .trim();

        for (const capture of captures || []) {
            const parsed = notionNetworkParseJson(capture?.responseText);
            const blockMap = parsed?.recordMap?.block;
            if (!blockMap || typeof blockMap !== 'object') continue;

            for (const [blockId, record] of Object.entries(blockMap)) {
                const value = notionNetworkUnwrapRecord(record);
                if (!value) continue;

                const id = String(value.id || blockId);
                const previous = blocks.get(id) || {};
                const format = value.format && typeof value.format === 'object'
                    ? value.format
                    : {};

                const aliasPointer =
                    format.alias_pointer ||
                    format.aliasPointer ||
                    {};
                const linkTarget =
                    String(
                        aliasPointer.id ||
                        format.page_id ||
                        format.pageId ||
                        value.page_id ||
                        value.pageId ||
                        ''
                    );

                blocks.set(id, {
                    ...previous,
                    id,
                    type: String(value.type || previous.type || ''),
                    title: plain(value?.properties?.title) || previous.title || '',
                    parentTable: String(
                        value.parent_table ||
                        value.parentTable ||
                        previous.parentTable ||
                        ''
                    ),
                    content: Array.isArray(value.content)
                        ? value.content.filter(Boolean).map(String)
                        : (Array.isArray(previous.content) ? previous.content : []),
                    targetPageId: linkTarget || previous.targetPageId || ''
                });
            }
        }

        const headingTypes = new Set([
            'heading_1', 'heading_2', 'heading_3',
            'header', 'sub_header', 'sub_sub_header'
        ]);

        const entries = [];
        const seenTargets = new Set();
        let order = 0;

        const walk = (containerId, inheritedGroup = '') => {
            const container = blocks.get(String(containerId || ''));
            if (!container) return;

            let currentGroup = inheritedGroup;

            for (const childIdRaw of container.content || []) {
                const childId = String(childIdRaw || '');
                const child = blocks.get(childId);
                if (!child) continue;

                if (
                    headingTypes.has(child.type) &&
                    String(child.title || '').trim()
                ) {
                    currentGroup = String(child.title).trim();
                    continue;
                }

                let targetId = '';
                if (
                    child.type === 'page' &&
                    child.parentTable !== 'collection'
                ) {
                    targetId = child.id;
                } else if (
                    child.type === 'alias' ||
                    child.type === 'link_to_page'
                ) {
                    targetId = String(child.targetPageId || '');
                } else if (child.type === 'collection_view_page') {
                    // A full-page database can itself be linked from the menu.
                    targetId = child.id;
                }

                if (targetId && !seenTargets.has(targetId)) {
                    seenTargets.add(targetId);
                    entries.push({
                        pageId: targetId,
                        sourceBlockId: child.id,
                        name: String(child.title || '').trim() || 'Notion page',
                        groupName: currentGroup,
                        order: order++
                    });
                }

                // Normal subpage blocks remain connected to the root tree once
                // loadCachedPageChunkV2 fills their content, so recurse when
                // content is already available.
                if (child.content?.length) {
                    walk(child.id, currentGroup);
                }
            }
        };

        if (rootId) walk(rootId, '');

        return entries;
    }

    async function notionNetworkDeepLoadExternalNavigation(
        rootUrl,
        initialCaptures,
        onStatus = () => {}
    ) {
        const captures = Array.isArray(initialCaptures)
            ? [...initialCaptures]
            : [];
        const loaded = new Set();
        const navigationMeta = new Map();
        const origin = new URL(rootUrl).origin;
        const rootPageId = String(
            notionNetworkIdsFromPublicUrl(rootUrl).pageId || ''
        );
        const MAX_PAGES = 48;

        // The browser may have opened a child DB from cache while our
        // interceptor was attaching. Always load the source URL's root page
        // explicitly so its menu / headings / linked pages are available.
        if (rootPageId) {
            try {
                onStatus('Notion 루트 페이지 구조 확인 중…');
                const result = await notionNetworkGmPostJson(
                    `${origin}/api/v3/loadCachedPageChunkV2`,
                    {
                        page: { id: rootPageId },
                        limit: 100,
                        cursor: { stack: [] },
                        chunkNumber: 0,
                        verticalColumns: false
                    },
                    'external root page structure'
                );
                loaded.add(rootPageId);
                captures.push({
                    url: result.url || '',
                    method: 'POST',
                    status: result.status || 200,
                    requestBody: result.requestBody || '',
                    responseText: String(result.responseText || ''),
                    priority: 99,
                    capturedAt: Date.now()
                });
            } catch (error) {
                console.warn(
                    `[${APP_NAME}] external root page structure load failed`,
                    error
                );
            }
        }

        // Up to three generations: root menu -> child page -> nested child page.
        for (let round = 0; round < 3 && loaded.size < MAX_PAGES; round++) {
            const entries = notionNetworkExternalNavigationEntries(rootUrl, captures);

            for (const entry of entries) {
                if (!navigationMeta.has(entry.pageId)) {
                    navigationMeta.set(entry.pageId, {
                        groupName: String(entry.groupName || ''),
                        order: Number(entry.order || 0),
                        name: String(entry.name || '')
                    });
                }
            }

            const pending = entries
                .map(entry => entry.pageId)
                .filter(id => id && !loaded.has(id))
                .slice(0, MAX_PAGES - loaded.size);

            if (!pending.length) break;

            onStatus(
                `Notion 하위 페이지 구조 확인 중… ${loaded.size}/${Math.min(MAX_PAGES, loaded.size + pending.length)}`
            );

            let cursor = 0;
            const workerCount = Math.min(4, pending.length);
            const worker = async () => {
                while (true) {
                    const index = cursor++;
                    if (index >= pending.length) return;
                    const pageId = pending[index];
                    loaded.add(pageId);

                    try {
                        const result = await notionNetworkGmPostJson(
                            `${origin}/api/v3/loadCachedPageChunkV2`,
                            {
                                page: { id: pageId },
                                limit: 100,
                                cursor: { stack: [] },
                                chunkNumber: 0,
                                verticalColumns: false
                            },
                            'external child page structure'
                        );

                        captures.push({
                            url: result.url || '',
                            method: 'POST',
                            status: result.status || 200,
                            requestBody: result.requestBody || '',
                            responseText: String(result.responseText || ''),
                            priority: 96,
                            capturedAt: Date.now()
                        });
                    } catch (error) {
                        console.warn(
                            `[${APP_NAME}] external child page structure skipped`,
                            pageId,
                            error
                        );
                    }
                }
            };

            await Promise.all(
                Array.from({ length: workerCount }, () => worker())
            );
        }

        return {
            captures,
            navigationMeta
        };
    }

    function notionNetworkDiscoverExternalDatabases(
        rootUrl,
        captures,
        queryState = null,
        navigationMeta = new Map()
    ) {
        const collections = new Map();
        const blocks = new Map();
        const candidates = new Map();
        const plainName = value =>
            notionNetworkInternalRichTextToPlain(value)
                .replace(/\u0000/g, '')
                .trim();

        const register = parsed => {
            const collectionMap = parsed?.recordMap?.collection;
            if (collectionMap && typeof collectionMap === 'object') {
                for (const [collectionId, record] of Object.entries(collectionMap)) {
                    const value = notionNetworkUnwrapRecord(record);
                    if (!value) continue;
                    collections.set(String(value.id || collectionId), {
                        id: String(value.id || collectionId),
                        title: plainName(value.name) || 'Notion DB',
                        spaceId: String(value.space_id || record?.spaceId || '')
                    });
                }
            }

            const blockMap = parsed?.recordMap?.block;
            if (!blockMap || typeof blockMap !== 'object') return;
            for (const [blockId, record] of Object.entries(blockMap)) {
                const value = notionNetworkUnwrapRecord(record);
                if (!value) continue;
                const id = String(value.id || blockId);
                const previous = blocks.get(id) || {};
                const content = Array.isArray(value.content)
                    ? value.content.filter(Boolean).map(String)
                    : (Array.isArray(previous.content) ? previous.content : []);
                blocks.set(id, {
                    ...previous,
                    id,
                    type: String(value.type || previous.type || ''),
                    parentId: String(
                        value.parent_id ||
                        value.parentId ||
                        previous.parentId ||
                        ''
                    ),
                    parentTable: String(
                        value.parent_table ||
                        value.parentTable ||
                        previous.parentTable ||
                        ''
                    ),
                    content,
                    collectionId: String(
                        value.collection_id ||
                        value?.format?.collection_pointer?.id ||
                        previous.collectionId ||
                        ''
                    ),
                    viewIds: Array.isArray(value.view_ids)
                        ? value.view_ids.filter(Boolean).map(String)
                        : (Array.isArray(previous.viewIds) ? previous.viewIds : []),
                    spaceId: String(
                        value.space_id ||
                        record?.spaceId ||
                        previous.spaceId ||
                        ''
                    ),
                    title: plainName(value?.properties?.title) || previous.title || ''
                });
            }
        };

        for (const capture of captures || []) {
            const parsed = notionNetworkParseJson(capture?.responseText);
            if (parsed) register(parsed);
        }

        const idsFromUrl = notionNetworkIdsFromPublicUrl(rootUrl);
        const rootPageId = String(idsFromUrl.pageId || '');

        // Only blocks reachable from the URL root OR from linked pages that
        // were explicitly discovered under that root are part of this source.
        // This still excludes unrelated app.notion.com workspace preload data,
        // while allowing Notion link/alias blocks whose target page is not a
        // literal child in the root block's `content` array.
        const reachable = new Set();
        const visit = idValue => {
            const id = String(idValue || '');
            if (!id || reachable.has(id)) return;
            reachable.add(id);
            const block = blocks.get(id);
            if (!block) return;

            // DFS preserves Notion visual order:
            // left column top->bottom, then right column top->bottom.
            for (const childId of block.content || []) {
                visit(String(childId));
            }
        };

        if (rootPageId) visit(rootPageId);

        for (const pageId of navigationMeta?.keys?.() || []) {
            visit(String(pageId));
        }

        const parentByChild = new Map();
        for (const parent of blocks.values()) {
            for (const childId of parent.content || []) {
                if (!parentByChild.has(String(childId))) {
                    parentByChild.set(String(childId), String(parent.id || ''));
                }
            }
        }

        const reachableOrder = new Map();
        let reachableIndex = 0;
        for (const id of reachable) {
            reachableOrder.set(String(id), reachableIndex++);
        }

        const headingTypes = new Set([
            'heading_1', 'heading_2', 'heading_3',
            'header', 'sub_header', 'sub_sub_header'
        ]);

        const navigationForBlock = blockId => {
            let currentId = String(blockId || '');
            let guard = 0;
            while (currentId && guard++ < 50) {
                const meta = navigationMeta?.get?.(currentId);
                if (meta) return meta;
                currentId = parentByChild.get(currentId) || '';
            }
            return null;
        };

        const groupForBlock = blockId => {
            const nav = navigationForBlock(blockId);
            if (String(nav?.groupName || '').trim()) {
                return String(nav.groupName).trim();
            }

            let branchId = String(blockId || '');
            let parentId = parentByChild.get(branchId) || '';
            let outerHeading = '';
            let guard = 0;

            // Walk from the DB toward the root. At each level, look for the
            // closest heading immediately before the branch that contains this
            // DB. Keep walking so an outer layout heading (e.g. "인물·포즈")
            // wins over a heading internal to the DB's own subpage.
            while (parentId && guard++ < 40) {
                const parent = blocks.get(parentId);
                if (parent) {
                    const siblings = Array.isArray(parent.content)
                        ? parent.content.map(String)
                        : [];
                    const index = siblings.indexOf(branchId);

                    if (index >= 0) {
                        for (let i = index - 1; i >= 0; i--) {
                            const sibling = blocks.get(String(siblings[i]));
                            if (
                                sibling &&
                                headingTypes.has(String(sibling.type || '')) &&
                                String(sibling.title || '').trim()
                            ) {
                                outerHeading = String(sibling.title).trim();
                                break;
                            }
                        }
                    }
                }

                branchId = parentId;
                parentId = parentByChild.get(branchId) || '';
            }

            return outerHeading;
        };

        const addCandidate = block => {
            if (!block) return;
            if (
                block.type !== 'collection_view' &&
                block.type !== 'collection_view_page'
            ) return;

            const collectionId = String(block.collectionId || '');
            const viewId = String(block.viewIds?.[0] || '');
            if (!collectionId || !viewId) return;

            const collection = collections.get(collectionId);
            const existing = candidates.get(collectionId);
            if (!existing || block.type === 'collection_view_page') {
                candidates.set(collectionId, {
                    id: collectionId,
                    kind: 'database',
                    name:
                        collection?.title ||
                        block.title ||
                        'Notion DB',
                    collectionId,
                    blockId: String(block.id || ''),
                    viewId,
                    spaceId: String(
                        block.spaceId ||
                        collection?.spaceId ||
                        ''
                    ),
                    rootUrl: String(rootUrl || ''),
                    groupName: groupForBlock(block.id),
                    order: Number(
                        navigationForBlock(block.id)?.order ??
                        reachableOrder.get(String(block.id)) ??
                        999999
                    ),
                    items: existing?.items || [],
                    lastSync: Number(existing?.lastSync || 0),
                    error: String(existing?.error || '')
                });
            }
        };

        if (rootPageId && reachable.size) {
            for (const id of reachable) addCandidate(blocks.get(id));
        }

        const isRootMenuBlock = block => {
            if (!block || !rootPageId) return false;
            if (String(block.parentId || '') === rootPageId) return true;

            const parent = blocks.get(String(block.parentId || ''));
            if (!parent || parent.type !== 'column') return false;

            const grand = blocks.get(String(parent.parentId || ''));
            return Boolean(
                grand &&
                grand.type === 'column_list' &&
                String(grand.parentId || '') === rootPageId
            );
        };

        // This Notion layout is not "many databases": most menu entries are
        // ordinary pages. Surface those pages as selectable sections too.
        for (const [pageId, meta] of navigationMeta?.entries?.() || []) {
            const block = blocks.get(String(pageId));
            if (!block || block.type !== 'page') continue;
            if (!isRootMenuBlock(block)) continue;

            const id = `page:${pageId}`;
            if (candidates.has(id)) continue;

            candidates.set(id, {
                id,
                kind: 'page',
                pageId: String(pageId),
                blockId: String(pageId),
                name:
                    String(meta?.name || '').trim() ||
                    String(block.title || '').trim() ||
                    'Notion page',
                collectionId: '',
                viewId: '',
                spaceId: String(block.spaceId || ''),
                rootUrl: String(rootUrl || ''),
                groupName:
                    String(meta?.groupName || '').trim() ||
                    groupForBlock(pageId),
                order: Number(
                    meta?.order ??
                    reachableOrder.get(String(pageId)) ??
                    999999
                ),
                items: [],
                lastSync: 0,
                error: ''
            });
        }

        // A URL can point directly at a database and queryCollection may be the
        // only place where its collection/view IDs are available. Accept this
        // only when the query's collectionViewBlock is the root itself (or a
        // descendant of it), never merely because it appeared in app preload.
        const compiled = queryState?.compiledRequest;
        const requestPayload = queryState?.requestPayload;
        const queryCollectionId = String(compiled?.source?.id || '');
        const queryViewId = String(
            compiled?.collectionView?.id ||
            requestPayload?.collectionView?.id ||
            ''
        );
        const queryBlockId = String(
            requestPayload?.collectionViewBlock?.id ||
            ''
        );
        const queryBelongsToRoot =
            !rootPageId ||
            queryBlockId === rootPageId ||
            reachable.has(queryBlockId) ||
            navigationMeta?.has?.(queryBlockId);

        if (
            queryCollectionId &&
            queryViewId &&
            queryBlockId &&
            queryBelongsToRoot &&
            !candidates.has(queryCollectionId)
        ) {
            const collection = collections.get(queryCollectionId);
            candidates.set(queryCollectionId, {
                id: queryCollectionId,
                kind: 'database',
                name: collection?.title || 'Notion DB',
                collectionId: queryCollectionId,
                blockId: queryBlockId,
                viewId: queryViewId,
                spaceId: String(
                    compiled?.source?.spaceId ||
                    compiled?.collectionView?.spaceId ||
                    collection?.spaceId ||
                    ''
                ),
                rootUrl: String(rootUrl || ''),
                groupName: groupForBlock(queryBlockId),
                order: Number(
                    navigationForBlock(queryBlockId)?.order ??
                    reachableOrder.get(queryBlockId) ??
                    999999
                ),
                items: [],
                lastSync: 0,
                error: ''
            });
        }

        return [...candidates.values()].sort((a, b) =>
            Number(a.order ?? 999999) - Number(b.order ?? 999999)
        );
    }

    function naiNotionMergeExternalDatabases(existingRows, discoveredRows) {
        const existing = Array.isArray(existingRows) ? existingRows : [];
        const discovered = Array.isArray(discoveredRows) ? discoveredRows : [];

        // A successful fresh discovery is authoritative for this source.
        // Older versions could accidentally cache unrelated app.notion.com
        // workspace DBs; carrying unmatched old rows forward would keep those
        // ghosts forever.
        if (discovered.length) {
            const oldMap = new Map(
                existing
                    .filter(row => row?.id)
                    .map(row => [String(row.id), row])
            );

            return discovered
                .filter(row => row?.id)
                .map(row => {
                    const old = oldMap.get(String(row.id)) || {};
                    return {
                        ...old,
                        ...row,
                        groupName: String(row.groupName || ''),
                        order: Number(row.order ?? old.order ?? 999999),
                        items: Array.isArray(old.items)
                            ? old.items
                            : (Array.isArray(row.items) ? row.items : []),
                        lastSync: Number(old.lastSync || row.lastSync || 0),
                        error: String(row.error || old.error || '')
                    };
                });
        }

        // If discovery itself yielded nothing, keep the previous cache rather
        // than deleting valid DBs because of a transient Notion load failure.
        return [...existing];
    }

    async function notionNetworkLoadExternalDatabaseSectionDirect(
        rootUrl,
        section,
        onStatus = () => {}
    ) {
        const previousJob = notionCrawlerJobRead();
        const jobId = createId();

        const job = {
            id: jobId,
            mode: 'network-intercept',
            status: 'running',
            rootUrl: normalizeUrl(rootUrl),
            targetDatabase: {
                id: String(section?.id || section?.collectionId || ''),
                name: String(section?.name || '외부 DB'),
                collectionId: String(section?.collectionId || section?.id || ''),
                blockId: String(section?.blockId || ''),
                viewId: String(section?.viewId || ''),
                spaceId: String(section?.spaceId || '')
            },
            captures: [],
            queryCollection: null,
            message: `“${section?.name || '외부 DB'}” 직접 동기화 준비 중…`,
            startedAt: Date.now(),
            updatedAt: Date.now()
        };

        if (!job.targetDatabase.blockId || !job.targetDatabase.viewId) {
            throw new Error('이 DB의 blockId/viewId를 찾지 못했습니다.');
        }

        try {
            notionCrawlerJobWrite(job);
            onStatus(`“${section?.name || '외부 DB'}” DB 직접 동기화 중…`);

            // This function already knows how to:
            // query the selected collectionView directly,
            // fetch row children with syncRecordValues,
            // and reconstruct readable prompt pages.
            // Calling it here avoids opening/waiting for a helper Notion tab.
            const expanded = await notionNetworkExpandCapturedRows();
            const current = notionCrawlerJobRead();

            const readablePages = Array.isArray(expanded?.readablePages)
                ? expanded.readablePages
                : [];

            if (!readablePages.length) {
                throw new Error(
                    `DB row ${Number(expanded?.rows || 0)}개는 확인했지만 읽을 수 있는 프롬프트 본문을 복원하지 못했습니다.`
                );
            }

            return {
                captures: [],
                readablePages,
                queryCollection:
                    current?.queryCollection &&
                    typeof current.queryCollection === 'object'
                        ? current.queryCollection
                        : null
            };
        } finally {
            // Do not leave the temporary direct-sync job in GM storage.
            if (previousJob && typeof previousJob === 'object') {
                notionCrawlerJobWrite(previousJob);
            } else {
                GM_setValue(NOTION_BROWSER_JOB_KEY, null);
            }
        }
    }

    async function notionNetworkLoadExternalPageSection(
        rootUrl,
        section,
        onStatus = () => {}
    ) {
        const pageId = String(section?.pageId || section?.blockId || '');
        if (!pageId) throw new Error('선택한 Notion 페이지 ID를 찾지 못했습니다.');

        const origin = new URL(rootUrl).origin;
        const captures = [];
        const known = new Map();
        let spaceId = '';

        const mergeData = data => {
            const blockMap = data?.recordMap?.block;
            if (!blockMap || typeof blockMap !== 'object') return;

            for (const [id, record] of Object.entries(blockMap)) {
                const value = notionNetworkUnwrapRecord(record);
                if (!value) continue;

                known.set(String(value.id || id), value);
                if (!spaceId) {
                    spaceId = String(
                        value.space_id ||
                        record?.spaceId ||
                        ''
                    );
                }
            }
        };

        const pushCapture = result => {
            captures.push({
                url: result.url || '',
                method: 'POST',
                status: result.status || 200,
                requestBody: result.requestBody || '',
                responseText: String(result.responseText || ''),
                priority: 98,
                capturedAt: Date.now()
            });
            mergeData(result.data);
        };

        onStatus(`“${section?.name || 'Notion 페이지'}” 내용 읽는 중…`);

        const rootResult = await notionNetworkGmPostJson(
            `${origin}/api/v3/loadCachedPageChunkV2`,
            {
                page: { id: pageId },
                limit: 100,
                cursor: { stack: [] },
                chunkNumber: 0,
                verticalColumns: false
            },
            'external page section'
        );
        pushCapture(rootResult);

        // loadCachedPageChunkV2 can return parent blocks whose child ids are
        // still unresolved. Resolve those child pointers exactly like Notion
        // does, so toggles / code blocks / text under the page are readable.
        const completed = new Set(known.keys());
        const attempted = new Set();

        for (let round = 0; round < 6; round++) {
            const pending = [];

            for (const block of known.values()) {
                for (const childIdRaw of Array.isArray(block?.content) ? block.content : []) {
                    const childId = String(childIdRaw || '');
                    if (
                        childId &&
                        !completed.has(childId) &&
                        !attempted.has(childId)
                    ) {
                        pending.push(childId);
                    }
                }
            }

            if (!pending.length || !spaceId) break;

            const batch = [...new Set(pending)].slice(0, 36);
            batch.forEach(id => attempted.add(id));

            try {
                const result = await notionNetworkGmPostJson(
                    `${origin}/api/v3/syncRecordValues`,
                    {
                        requests: batch.map(id => ({
                            pointer: {
                                table: 'block',
                                id,
                                spaceId
                            },
                            version: -1
                        }))
                    },
                    'external page section children'
                );
                pushCapture(result);

                const returned = result?.data?.recordMap?.block || {};
                for (const id of Object.keys(returned)) {
                    completed.add(String(id));
                }
            } catch (error) {
                console.warn(
                    `[${APP_NAME}] external page child sync skipped`,
                    error
                );
                break;
            }
        }

        return captures;
    }

    async function analyzeNotionViaNetworkIntercept(url, settings, onStatus = () => {}, targetDatabase = null) {
        const rootUrl = normalizeUrl(url);
        const isPageSection = targetDatabase?.kind === 'page';
        const isKnownDatabaseSection = Boolean(
            targetDatabase &&
            targetDatabase?.kind !== 'page' &&
            targetDatabase?.blockId &&
            targetDatabase?.viewId
        );

        let collected = {
            captures: [],
            readablePages: [],
            queryCollection: null
        };
        let captures = [];
        let discoveredDatabases = [];
        let pages = [];

        if (isPageSection) {
            captures = await notionNetworkLoadExternalPageSection(
                rootUrl,
                targetDatabase,
                onStatus
            );

            const allPages = notionNetworkBuildReadablePages(
                rootUrl,
                captures
            );

            // A selected category page can contain nested Notion pages/toggles
            // where the actual prompt sets live. The old code kept only the
            // outer page id, so categories such as 컨셉/배경/NSFW/GPT 프롬프트
            // were reduced to one shell page and produced 0 prompt sets.
            // notionNetworkLoadExternalPageSection() only captures this selected
            // page subtree, so every readable page here belongs to the category.
            pages = allPages;
        } else if (isKnownDatabaseSection) {
            // A selected DB already has collection/view/block ids from root
            // discovery. Query it directly instead of opening a helper tab and
            // waiting up to ~2 minutes for intercepted network traffic.
            collected = await naiNotionWithExternalDbDirectLock(
                () => notionNetworkLoadExternalDatabaseSectionDirect(
                    rootUrl,
                    targetDatabase,
                    onStatus
                )
            );
            captures = Array.isArray(collected?.captures)
                ? collected.captures
                : [];
            pages = Array.isArray(collected?.readablePages)
                ? collected.readablePages
                : [];
        } else {
            // Whole-source refresh/discovery no longer needs a helper Notion tab.
            // We already know the root page id from the URL, so load it directly
            // with Notion's internal API, then walk its linked child pages.
            onStatus('Notion 분류 구조 직접 확인 중…');

            const deepStructure =
                await notionNetworkDeepLoadExternalNavigation(
                    rootUrl,
                    [],
                    onStatus
                );

            captures = deepStructure.captures;
            discoveredDatabases =
                notionNetworkDiscoverExternalDatabases(
                    rootUrl,
                    captures,
                    null,
                    deepStructure.navigationMeta
                );

            if (!discoveredDatabases.length) {
                throw new Error(
                    'Notion 루트 페이지는 읽었지만 선택 가능한 분류를 찾지 못했습니다.'
                );
            }

            // Source-level refresh only needs the category/page map. Prompt
            // extraction happens when a specific category is synced.
            return {
                pageTitle: 'Notion',
                concepts: [],
                method: 'notion-direct-discovery',
                pagesVisited: 0,
                assetsVisited: captures.length,
                errors: 0,
                externalDatabases: discoveredDatabases,
                activeExternalDatabaseId: '',
                pageAssets: []
            };
        }

        if (!pages.length) {
            const queryState = collected?.queryCollection;
            const rowCount = Array.isArray(queryState?.blockIds)
                ? queryState.blockIds.length
                : 0;
            const sizeHint = Number(queryState?.sizeHint || 0);
            throw new Error(
                rowCount
                    ? `Notion queryCollection에서 row ${rowCount}${sizeHint ? `/${sizeHint}` : ''}개는 확인했지만 자식 block 본문을 직접 조회하지 못했습니다.`
                    : `Notion 내부 API 응답 ${captures.length}개는 잡았지만 queryCollection row 목록을 복구하지 못했습니다.`
            );
        }

        // Fast path: parse clearly structured Notion prompt pages directly.
        // Gemini is now a fallback only for pages whose structure is ambiguous.
        const directConcepts = [];
        const remainingPages = [];
        for (const page of pages) {
            const concept = notionDirectPromptConcept(page);
            if (concept) directConcepts.push(concept);
            else remainingPages.push(page);
        }

        onStatus(
            `Notion 내부 API에서 ${pages.length}개 row/page 복원 · ` +
            `직접 추출 ${directConcepts.length}개` +
            (remainingPages.length ? ` · AI 확인 ${remainingPages.length}개` : '')
        );

        // Keep external Notion AI batches deliberately small. A large public DB can
        // contain dozens of prompt pages; asking Gemini to echo all original prompts
        // into one JSON response can hit output limits and leave a truncated/invalid
        // JSON document. Six pages / ~14k chars keeps both input and output bounded.
        const batches = splitRenderedNotionPagesIntoBatches(remainingPages, 14000, 6);
        if (!directConcepts.length && !batches.length) {
            throw new Error(
                `Notion 내부 API에서 ${pages.length}개 row/page를 복원했지만 분석할 텍스트가 없습니다.`
            );
        }

        if (batches.length) {
            const settingsError = validateSettings(settings);
            if (settingsError) {
                throw new Error(`AI fallback 설정 필요: ${settingsError}`);
            }
        }

        const concepts = [...directConcepts];
        const conceptKeys = new Set(
            directConcepts.map(concept =>
                conceptFingerprint(concept.tags, concept.negativeTags, concept.characters)
            ).filter(Boolean)
        );
        let pageTitle = pages[0]?.title || 'Notion';
        let errors = 0;
        let emptyBatches = 0;
        let lastBatchError = '';

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            onStatus(
                `Notion 내부 row/page Gemini 분석 ${i + 1}/${batches.length} · ` +
                `${batch.length}개 처리 중…`
            );

            try {
                const response = await callProvider(
                    buildRenderedNotionBatchPrompt(rootUrl, batch, settings),
                    settings,
                    {
                        useUrlContext: false,
                        jsonMode: true
                    }
                );

                const parsed = parseRenderedNotionBatchJson(
                    response.text,
                    batch
                );

                if (parsed.pageTitle) pageTitle = parsed.pageTitle;
                if (!(parsed.concepts || []).length) emptyBatches += 1;

                const pageByUrl = new Map(
                    batch.map(page => [String(page.url || ''), page])
                );
                for (const concept of parsed.concepts || []) {
                    const fingerprint = conceptFingerprint(
                        concept.tags,
                        concept.negativeTags,
                        concept.characters
                    );
                    if (!fingerprint || conceptKeys.has(fingerprint)) continue;
                    const wantedTitle = String(concept.sourcePageTitle || '').trim();
                    const wantedName = String(concept.suggestedName || '').trim();
                    const sourcePage =
                        pageByUrl.get(String(concept.sourceUrl || '')) ||
                        batch.find(page => wantedTitle && String(page.title || '').trim() === wantedTitle) ||
                        batch.find(page => wantedName && String(page.title || '').trim() === wantedName) ||
                        (batch.length === 1 ? batch[0] : null);
                    if (sourcePage?.imageUrl) {
                        concept._notionImageUrl = String(sourcePage.imageUrl);
                    }
                    conceptKeys.add(fingerprint);
                    concepts.push(concept);
                }
            } catch (error) {
                errors += 1;
                lastBatchError = String(error?.message || error || '').trim();
                console.warn(
                    `[${APP_NAME}] Notion internal batch analysis skipped`,
                    i,
                    error
                );
            }
        }

        if (!concepts.length) {
            const diag = pages
                .slice(0, 8)
                .map(page => `${page.title || '제목없음'}(${page.text.length}자)`)
                .join(' / ');

            const aiDiag = [
                `AI 배치 ${batches.length}개`,
                errors ? `오류 ${errors}개` : '',
                emptyBatches ? `빈 결과 ${emptyBatches}개` : '',
                lastBatchError ? `마지막 오류: ${lastBatchError.slice(0, 500)}` : ''
            ].filter(Boolean).join(' · ');

            throw new Error(
                `Notion 내부 API로 ${pages.length}개 page까지 읽었지만 Prompt 세트를 찾지 못했습니다.` +
                (aiDiag ? `\nAI 진단: ${aiDiag}` : '') +
                (diag ? `\n복원 진단: ${diag}` : '')
            );
        }

        return {
            pageTitle,
            concepts,
            method: 'notion-network-intercept',
            pagesVisited: pages.length,
            assetsVisited: captures.length,
            errors,
            externalDatabases: discoveredDatabases,
            activeExternalDatabaseId:
                String(
                    targetDatabase?.id ||
                    targetDatabase?.collectionId ||
                    collected?.queryCollection?.compiledRequest?.source?.id ||
                    ''
                ),
            pageAssets: pages.map(page => ({
                url: String(page?.url || ''),
                title: String(page?.title || ''),
                imageUrl: String(page?.imageUrl || '')
            }))
        };
    }


    async function collectNotionRenderedPages(rootUrl, onStatus = () => {}) {
        const jobId = createId();
        const root = normalizeUrl(rootUrl);
        const job = {
            id: jobId,
            status: 'running',
            rootUrl: root,
            current: { url: root, title: '', depth: 0 },
            queue: [],
            visited: [],
            pages: [],
            message: 'Notion 실제 화면 탐색 탭 여는 중...',
            startedAt: Date.now(),
            updatedAt: Date.now()
        };

        notionCrawlerJobWrite(job);

        const helperTab = openNotionCrawlerTab(root, jobId);

        if (!helperTab) {
            notionCrawlerJobWrite({
                ...job,
                status: 'error',
                error: '브라우저가 Notion 탐색 탭을 차단했습니다. novelai.net의 팝업을 허용한 뒤 다시 시도해주세요.'
            });
            throw new Error(
                'Notion 탐색용 탭을 열 수 없습니다. novelai.net 팝업 허용 후 다시 시도해주세요.'
            );
        }

        const started = Date.now();
        let lastMessage = '';

        while (Date.now() - started < NOTION_BROWSER_MAX_WAIT_MS) {
            await sleepMs(600);

            const current = notionCrawlerJobRead();
            if (!current || current.id !== jobId) {
                throw new Error('Notion 탐색 작업 정보가 사라졌습니다.');
            }

            if (current.message && current.message !== lastMessage) {
                lastMessage = current.message;
                onStatus(current.message);
            }

            if (current.status === 'done') {
                GM_setValue(NOTION_BROWSER_JOB_KEY, null);
                return Array.isArray(current.pages) ? current.pages : [];
            }

            if (current.status === 'error') {
                GM_setValue(NOTION_BROWSER_JOB_KEY, null);
                throw new Error(current.error || 'Notion 실제 화면 탐색 실패');
            }

            let helperClosed = false;
            try {
                helperClosed = helperTab.isClosed();
            } catch (_) {}

            if (helperClosed) {
                throw new Error(
                    'Notion 탐색 탭이 완료 전에 닫혔습니다. 다시 시도해주세요.'
                );
            }
        }

        GM_setValue(NOTION_BROWSER_JOB_KEY, null);
        helperTab.close();
        throw new Error('Notion 탐색 시간이 초과되었습니다.');
    }

    async function analyzeNotionViaRenderedBrowser(
        url,
        settings,
        onStatus = () => {}
    ) {
        const rootUrl = normalizeUrl(url);
        const pages = await collectNotionRenderedPages(rootUrl, onStatus);

        if (!pages.length) {
            throw new Error('Notion 탭은 열렸지만 렌더링된 페이지 본문을 수집하지 못했습니다.');
        }

        onStatus(
            `Notion 실제 화면 ${pages.length}개 페이지 수집 완료\nAI 태그 분석 준비 중...`
        );

        const batches = splitRenderedNotionPagesIntoBatches(pages);
        if (!batches.length) {
            throw new Error(
                `Notion ${pages.length}개 페이지를 열었지만 분석할 본문 텍스트가 없습니다.`
            );
        }

        const concepts = [];
        const conceptKeys = new Set();
        let pageTitle = pages[0]?.title || 'Notion';
        let errors = 0;

        for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            onStatus(
                `Notion 본문 AI 분석 ${i + 1}/${batches.length}\n` +
                `${batch.length}개 페이지 처리 중...`
            );

            try {
                const response = await callProvider(
                    buildRenderedNotionBatchPrompt(rootUrl, batch, settings),
                    settings,
                    {
                        useUrlContext: false,
                        jsonMode: true
                    }
                );

                const parsed = parseRenderedNotionBatchJson(
                    response.text,
                    batch
                );

                if (parsed.pageTitle) pageTitle = parsed.pageTitle;

                for (const concept of parsed.concepts) {
                    const fingerprint = conceptFingerprint(concept.tags, concept.negativeTags, concept.characters);
                    if (!fingerprint || conceptKeys.has(fingerprint)) continue;
                    conceptKeys.add(fingerprint);
                    concepts.push(concept);
                }
            } catch (_) {
                errors += 1;
            }
        }

        if (!concepts.length) {
            const pageDiag = pages
                .slice(0, 8)
                .map(page => `${page.title || '제목없음'}(본문 ${page.text.length}, 링크 ${page.linkCount})`)
                .join(' / ');

            throw new Error(
                `Notion ${pages.length}개 실제 페이지를 열었지만 태그 묶음을 찾지 못했습니다.` +
                (pageDiag ? `\n수집 진단: ${pageDiag}` : '')
            );
        }

        return {
            pageTitle,
            concepts,
            method: 'notion-browser-crawl',
            pagesVisited: pages.length,
            assetsVisited: 0,
            errors
        };
    }

    async function analyzeSingleSharedUrl(url, settings, onStatus = () => {}) {
        const normalizedUrl = normalizeUrl(url);
        let firstError = null;

        try {
            onStatus('URL Context로 페이지 읽는 중...');

            const first = await callProvider(
                buildAnalyzePrompt(normalizedUrl, '', settings),
                settings,
                {
                    useUrlContext: true,
                    jsonMode: false
                }
            );

            if (urlContextClearlyFailed(first.urlStatus)) {
                throw new Error('AI가 URL Context로 페이지를 가져오지 못했습니다.');
            }

            const parsed = parseAnalysisJson(first.text);

            if (parsed.concepts.length) {
                return {
                    ...parsed,
                    method: 'url-context'
                };
            }

            throw new Error('URL Context 분석에서 태그 묶음을 찾지 못했습니다.');
        } catch (error) {
            firstError = error;
        }

        onStatus(
            'URL Context 분석이 충분하지 않아 원문 직접 가져오기 fallback 시도 중...'
        );

        try {
            const pageText = await fetchPublicPageText(normalizedUrl);

            onStatus('가져온 원문을 AI로 분석 중...');

            const second = await callProvider(
                buildAnalyzePrompt(normalizedUrl, pageText, settings),
                settings,
                {
                    useUrlContext: false,
                    jsonMode: true
                }
            );

            const parsed = parseAnalysisJson(second.text);

            if (!parsed.concepts.length) {
                throw new Error('페이지에서 태그 묶음을 찾지 못했습니다.');
            }

            return {
                ...parsed,
                method: 'direct-fetch'
            };
        } catch (fallbackError) {
            const prefix = firstError
                ? `URL Context: ${firstError.message}\n`
                : '';

            throw new Error(
                `${prefix}Fallback: ${fallbackError.message}`
            );
        }
    }

    async function analyzeUrlContextOnly(url, settings, onStatus = () => {}) {
        const normalizedUrl = normalizeUrl(url);
        onStatus('Gemini URL Context로 공개 페이지 읽는 중...');
        const response = await callProvider(
            buildAnalyzePrompt(normalizedUrl, '', settings),
            settings,
            { useUrlContext: true, jsonMode: false }
        );
        if (urlContextClearlyFailed(response.urlStatus)) {
            throw new Error('Gemini URL Context가 이 페이지를 가져오지 못했습니다.');
        }
        const parsed = parseAnalysisJson(response.text);
        if (!parsed.concepts.length) {
            throw new Error('이 공개 Notion DB는 Gemini URL Context에서 내부 카드/Prompt를 노출하지 않습니다. URL Context 방식으로는 동기화할 수 없습니다.');
        }
        return { ...parsed, method: 'url-context-only' };
    }

    async function analyzeSharedUrl(url, settings, onStatus = () => {}) {
        const normalizedUrl = normalizeUrl(url);

        if (isNotionUrl(normalizedUrl)) {
            onStatus('Notion 링크 감지 · 내부 API 응답 가로채기 준비 중…');
            return analyzeNotionViaNetworkIntercept(
                normalizedUrl,
                settings,
                onStatus
            );
        }

        return analyzeSingleSharedUrl(
            normalizedUrl,
            settings,
            onStatus
        );
    }

    async function testProviderConnection(settings) {
        const result = await callProvider(
            'Reply with exactly: OK',
            settings,
            {
                useUrlContext: false,
                jsonMode: false
            }
        );

        if (!/\bOK\b/i.test(result.text)) {
            return `연결은 됐지만 예상 응답과 다릅니다: ${result.text.slice(0, 120)}`;
        }

        return '연결 성공: OK';
    }

    function validateSettings(settings) {
        if (settings.provider === 'gemini') {
            if (!String(settings.geminiKey || '').trim()) {
                return 'Gemini API Key가 비어 있습니다.';
            }

            return null;
        }

        if (settings.provider === 'vertex') {
            const parsed = parseServiceAccountJson(settings.vertexJson);

            if (!parsed.ok) return parsed.error;

            if (
                !String(settings.vertexProjectId || '').trim() &&
                !parsed.projectId
            ) {
                return 'Vertex project_id가 없습니다.';
            }

            return null;
        }

        if (settings.provider === 'firebase') {
            const config = parseFirebaseConfig(settings.firebaseConfig);

            if (!config?.apiKey || !config?.projectId) {
                return 'Firebase Config에서 apiKey/projectId를 찾지 못했습니다.';
            }

            return null;
        }

        return 'AI Provider를 선택해주세요.';
    }

    function findImageGenNavRow() {
        const currentRow = document.querySelector('.image-gen-nav-row');
        if (currentRow) return currentRow;

        const legacyNavbar = document.querySelector('.image-gen-navbar');
        return legacyNavbar?.firstElementChild || null;
    }

    function findImageGenMenuMount(row) {
        if (!row) return null;

        const menuButton = row.querySelector('button[aria-label="menu"]');

        if (menuButton) {
            const menuGroup = menuButton.parentElement;
            if (menuGroup && menuGroup !== row) {
                return {
                    parent: menuGroup,
                    before: menuButton,
                    menuButton,
                    mode: 'menu-group'
                };
            }

            return {
                parent: row,
                before: menuButton,
                menuButton,
                mode: 'row'
            };
        }

        const legacyMenuSlot = row.lastElementChild;
        if (!legacyMenuSlot) return null;

        return {
            parent: row,
            before: legacyMenuSlot,
            mode: 'legacy'
        };
    }

    function getNavbarMenuIconColor(menuButton) {
        if (!menuButton) return '';

        const icon = menuButton.querySelector('svg, [class]') || menuButton.firstElementChild;
        const candidates = [icon, menuButton].filter(Boolean);

        for (const element of candidates) {
            const style = getComputedStyle(element);
            const values = [
                style.backgroundColor,
                style.color,
                style.fill,
                style.stroke,
                style.webkitTextFillColor
            ];

            for (const value of values) {
                const color = String(value || '').trim();
                if (
                    color &&
                    color !== 'transparent' &&
                    color !== 'none' &&
                    color !== 'currentcolor' &&
                    !/^rgba?\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(color)
                ) {
                    return color;
                }
            }
        }

        return '';
    }

    function syncNavbarDiamondColor(menuButton, archiveButton) {
        if (!menuButton || !archiveButton) return;
        const iconColor = getNavbarMenuIconColor(menuButton);
        if (iconColor) {
            archiveButton.style.setProperty('--nai-nav-diamond-color', iconColor);
        } else {
            archiveButton.style.removeProperty('--nai-nav-diamond-color');
        }
    }

    function syncNavbarButtonAppearance(menuButton, archiveButton) {
        if (!menuButton || !archiveButton) return;

        const diamondColor = archiveButton.style.getPropertyValue('--nai-nav-diamond-color');
        archiveButton.className = menuButton.className || '';
        archiveButton.style.cssText = menuButton.style.cssText || '';
        if (diamondColor) {
            archiveButton.style.setProperty('--nai-nav-diamond-color', diamondColor);
        }
        syncNavbarDiamondColor(menuButton, archiveButton);
        syncGlobalAnalyzeUi();
    }

    function watchNavbarButtonAppearance(menuButton, archiveButton) {
        if (!menuButton || !archiveButton) return;

        let syncFrame = null;
        const scheduleSync = () => {
            if (syncFrame) cancelAnimationFrame(syncFrame);
            syncFrame = requestAnimationFrame(() => {
                syncFrame = null;
                if (!menuButton.isConnected || !archiveButton.isConnected) {
                    appearanceObserver.disconnect();
                    rootObserver.disconnect();
                    bodyObserver?.disconnect();
                    return;
                }
                syncNavbarButtonAppearance(menuButton, archiveButton);
            });
        };

        const appearanceObserver = new MutationObserver(scheduleSync);
        appearanceObserver.observe(menuButton, {
            attributes: true,
            attributeFilter: ['class', 'style']
        });

        const rootObserver = new MutationObserver(scheduleSync);
        rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
        });

        const bodyObserver = document.body
            ? new MutationObserver(scheduleSync)
            : null;
        bodyObserver?.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style', 'data-theme']
        });
    }

    function injectNavbarButton() {
        if (document.getElementById(BUTTON_ID)) return;

        const row = findImageGenNavRow();
        if (!row) return;

        const mount = findImageGenMenuMount(row);
        if (!mount?.parent || !mount?.before) return;

        const wrapper = document.createElement('div');
        wrapper.dataset.naiConceptLoaderSlot = 'true';
        wrapper.style.cssText =
            'flex:0 0 auto;min-width:0;display:flex;align-self:stretch;align-items:center;margin-right:6px;';

        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.title = APP_NAME;
        button.setAttribute('aria-label', APP_NAME);
        button.innerHTML = '<span class="nai-nav-diamond" aria-hidden="true">✦</span>';
        button.addEventListener('click', openModal);

        if (mount.menuButton) {
            syncNavbarButtonAppearance(mount.menuButton, button);
        } else {
            button.classList.add('nai-nav-legacy');
        }

        wrapper.appendChild(button);
        mount.parent.insertBefore(wrapper, mount.before);

        if (mount.menuButton) {
            watchNavbarButtonAppearance(mount.menuButton, button);
        }
        syncGlobalAnalyzeUi();
    }

    function openModal() {
        acknowledgeAnalysisCompletion();
        if (document.getElementById(MODAL_ID)) return;

        let activeTab = 'library';
        let currentProvider = getSettings().provider || 'gemini';
        let editingId = null;
        let editingDraft = null;
        let resourceEditingId = null;
        let resourceEditingDraft = null;
        let visibleResourceIds = [];
        let resourceDragState = null;
        let resourceDragSuppressClickUntil = 0;
        let visibleLibraryIds = [];
        let libraryDragState = null;
        let libraryDragSuppressClickUntil = 0;
        let memoEditingId = null;
        let memoEditingDraft = null;
        let visibleMemoIds = [];
        let memoDragState = null;
        let memoDragSuppressClickUntil = 0;
        let libraryCreateOpen = false;
        let resourceCreateOpen = false;
        let memoCreateOpen = false;
        const resourceCreateCategories = new Set();
        const memoCreateCategories = new Set();
        let manualDraft = {
            name: '',
            note: '',
            sourceUrl: '',
            tags: '',
            negativeTags: '',
            characters: [],
            categories: []
        };
        let isTesting = false;
        const libraryNoteSaveTimers = new Map();
        const expandedLibraryCards = new Set();
        const expandedLibraryNotes = new Set();
        const activeLibraryCategories = new Set();
        let libraryCategoryEditMode = false;
        const activeResourceCategories = new Set();
        let resourceCategoryEditMode = false;
        const activeMemoCategories = new Set();
        let memoCategoryEditMode = false;
        let shareImportDraft = null;

        const backupItemSelection = {
            library: new Set(),
            resources: new Set(),
            memos: new Set()
        };
        let backupSelectionInitialized = false;
        let restoreDraft = null;

        function persistLibraryNote(id, value) {
            const library = getLibrary();
            const index = library.findIndex(item => item.id === id);
            if (index < 0) return;

            const current = normalizeConceptRecord(library[index]);
            library[index] = {
                ...current,
                note: String(value || '').trim(),
                updatedAt: Date.now()
            };
            saveLibrary(library);

            const timer = libraryNoteSaveTimers.get(id);
            if (timer) clearTimeout(timer);
            libraryNoteSaveTimers.delete(id);
        }

        function scheduleLibraryNoteSave(id, value) {
            const oldTimer = libraryNoteSaveTimers.get(id);
            if (oldTimer) clearTimeout(oldTimer);

            const timer = setTimeout(() => {
                persistLibraryNote(id, value);
            }, 650);
            libraryNoteSaveTimers.set(id, timer);
        }

        const overlay = document.createElement('div');
        overlay.id = MODAL_ID;
        overlay.className = 'nai-loader-overlay';

        overlay.innerHTML = `
            <div class="nai-loader-modal">
                <div class="nai-loader-header">
                    <div class="nai-loader-title"><span>${APP_NAME}</span><span class="nai-loader-version">v${APP_VERSION}</span></div>
                    <button
                        type="button"
                        class="nai-loader-close"
                        data-action="close"
                    >×</button>
                </div>

                <div class="nai-loader-tabs">
                    <button
                        type="button"
                        class="nai-loader-tab active"
                        data-tab="library"
                    >라이브러리</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="resources"
                    >자료실</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="memos"
                    >메모</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="import"
                    >가져오기</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="backup"
                    >백업/복원</button>

                    <button
                        type="button"
                        class="nai-loader-tab"
                        data-tab="settings"
                        aria-label="설정"
                        title="설정"
                    >⚙</button>
                </div>

                <div class="nai-loader-content">
                    <section
                        class="nai-loader-panel active"
                        data-panel="library"
                    >
                        <div class="nai-library-toolbar">
                            <input
                                id="nai-library-search"
                                class="nai-loader-input nai-loader-grow"
                                type="text"
                                placeholder="제목/태그/메모 등 검색"
                            >
                            <button
                                type="button"
                                class="nai-loader-action nai-toolbar-search-button"
                                data-library-search-submit
                                title="검색"
                                aria-label="검색"
                            >
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <circle cx="11" cy="11" r="6.5"></circle>
                                    <path d="M16 16l4 4"></path>
                                </svg>
                            </button>
                        </div>

                        <div
                            id="nai-library-category-bar"
                            class="nai-library-category-bar"
                            aria-label="라이브러리 분류 필터"
                        ></div>

                        <div id="nai-library-create-wrap" class="nai-inline-create-wrap" hidden style="display:none!important;">
                            <div id="nai-manual-editor-root"></div>
                            <div id="nai-manual-status" class="nai-loader-status"></div>
                        </div>

                        <div
                            id="nai-library-list"
                            class="nai-library-list"
                        ></div>

                        <div
                            id="nai-library-status"
                            class="nai-loader-status"
                        ></div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="resources"
                    >
                        <div class="nai-library-toolbar">
                            <input id="nai-resource-search" class="nai-loader-input nai-loader-grow" type="text" placeholder="자료 검색">
                            <button
                                type="button"
                                class="nai-loader-action nai-toolbar-add-button"
                                data-create-toggle="resources"
                                title="새 자료 추가"
                                aria-label="새 자료 추가"
                                aria-expanded="false"
                            >+</button>
                        </div>

                        <div
                            id="nai-resource-category-bar"
                            class="nai-library-category-bar"
                            aria-label="자료실 분류 필터"
                        ></div>

                        <div id="nai-resource-create-wrap" class="nai-inline-create-wrap" hidden>
                            <div class="nai-info-create-card">
                                <div class="nai-loader-field">
                                    <label class="nai-loader-label">이름</label>
                                    <input id="nai-resource-name" class="nai-loader-input" type="text" placeholder="예: 야외 조명 태그 모음">
                                </div>
                                <div class="nai-loader-field nai-library-edit-category-field">
                                    <label class="nai-loader-label">분류</label>
                                    <div id="nai-resource-create-categories" class="nai-library-card-category-row" aria-label="새 자료 분류"></div>
                                </div>
                                <div class="nai-loader-field">
                                    <label class="nai-loader-label">링크</label>
                                    <input id="nai-resource-url" class="nai-loader-input" type="url" placeholder="https://...">
                                </div>
                                <div class="nai-loader-field" style="margin-bottom:10px;">
                                    <label class="nai-loader-label">메모 <span class="nai-loader-muted">(선택)</span></label>
                                    <textarea id="nai-resource-note" class="nai-loader-textarea" placeholder="어떤 자료인지 / 어디를 보면 되는지"></textarea>
                                </div>
                                <div class="nai-edit-footer-actions">
                                    <button type="button" class="nai-loader-action" data-resource-action="cancel-add">취소</button>
                                    <button type="button" class="nai-loader-action primary" data-resource-action="add">자료 저장</button>
                                </div>
                            </div>
                        </div>

                        <div id="nai-resource-list" class="nai-info-list"></div>
                        <div id="nai-resource-status" class="nai-loader-status"></div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="memos"
                    >
                        <div class="nai-library-toolbar">
                            <input id="nai-memo-search" class="nai-loader-input nai-loader-grow" type="text" placeholder="메모 검색">
                            <button
                                type="button"
                                class="nai-loader-action nai-toolbar-add-button"
                                data-create-toggle="memos"
                                title="새 메모 추가"
                                aria-label="새 메모 추가"
                                aria-expanded="false"
                            >+</button>
                        </div>

                        <div
                            id="nai-memo-category-bar"
                            class="nai-library-category-bar"
                            aria-label="메모 분류 필터"
                        ></div>

                        <div id="nai-memo-create-wrap" class="nai-inline-create-wrap" hidden>
                            <div class="nai-info-create-card">
                                <div class="nai-loader-field">
                                    <label class="nai-loader-label">제목 <span class="nai-loader-muted">(선택)</span></label>
                                    <input id="nai-memo-title" class="nai-loader-input" type="text" placeholder="예: 인페 테스트">
                                </div>
                                <div class="nai-loader-field nai-library-edit-category-field">
                                    <label class="nai-loader-label">분류</label>
                                    <div id="nai-memo-create-categories" class="nai-library-card-category-row" aria-label="새 메모 분류"></div>
                                </div>
                                <div class="nai-loader-field" style="margin-bottom:10px;">
                                    <label class="nai-loader-label">내용</label>
                                    <textarea id="nai-memo-content" class="nai-loader-textarea" placeholder="기억할 내용을 적어두세요"></textarea>
                                </div>
                                <div class="nai-edit-footer-actions">
                                    <button type="button" class="nai-loader-action" data-memo-action="cancel-add">취소</button>
                                    <button type="button" class="nai-loader-action primary" data-memo-action="add">메모 저장</button>
                                </div>
                            </div>
                        </div>

                        <div id="nai-memo-list" class="nai-info-list"></div>
                        <div id="nai-memo-status" class="nai-loader-status"></div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="import"
                    >
                        <div class="nai-loader-field" style="margin-bottom:10px;">
                            <label class="nai-loader-label">URL 또는 공유 코드</label>
                            <input
                                id="nai-import-url"
                                class="nai-loader-input"
                                type="text"
                                placeholder="https://... 또는 NAICL1:..."
                            >
                        </div>

                        <div class="nai-loader-row nai-import-action-row">
                            <button
                                type="button"
                                class="nai-loader-action"
                                data-action="load-share-code"
                            >공유 코드 불러오기</button>

                            <button
                                type="button"
                                class="nai-loader-action primary"
                                data-action="analyze"
                            >URL 가져오기</button>
                        </div>

                        <div
                            id="nai-import-status"
                            class="nai-loader-status"
                        ></div>

                        <div
                            id="nai-share-import-preview"
                            class="nai-share-import-preview"
                            hidden
                        ></div>

                        <div
                            id="nai-analysis-wrap"
                            style="display:none;"
                        >
                            <div class="nai-loader-divider"></div>

                            <div class="nai-loader-row nai-analysis-header-row">
                                <div class="nai-loader-section-title nai-loader-grow"
                                     style="margin:0;">
                                    발견된 태그 묶음
                                </div>

                                <button
                                    type="button"
                                    class="nai-loader-action"
                                    data-action="select-all-results"
                                >
                                    전체 선택
                                </button>

                                <button
                                    type="button"
                                    class="nai-loader-action"
                                    data-action="clear-all-results"
                                >
                                    전체 해제
                                </button>

                                <button
                                    type="button"
                                    class="nai-loader-action primary"
                                    data-action="save-selected"
                                >
                                    선택 항목 저장
                                </button>
                            </div>

                            <div
                                id="nai-analysis-meta"
                                class="nai-loader-muted"
                                style="margin-top:8px;"
                            ></div>

                            <div
                                id="nai-ai-results"
                                class="nai-ai-results"
                            ></div>
                        </div>

                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="backup"
                    >
                        <div class="nai-loader-section-title">백업</div>
                        <div class="nai-backup-box">
                            <div class="nai-loader-muted">백업할 항목을 개별 선택해서 JSON 파일로 저장합니다. 선택한 항목에서 사용하는 분류만 함께 저장되며 API 키와 설정은 포함되지 않습니다.</div>
                            <div id="nai-backup-item-sections" class="nai-backup-section-list"></div>
                            <div class="nai-backup-actions">
                                <button type="button" class="nai-loader-action primary" data-action="create-backup-file">선택 항목 백업</button>
                            </div>
                        </div>

                        <div class="nai-loader-divider"></div>

                        <div class="nai-loader-section-title">복원</div>
                        <div class="nai-backup-box">
                            <div class="nai-loader-muted">기존 데이터는 유지하고 병합합니다. 완전히 같은 컨셉/링크/메모는 자동으로 제외합니다.</div>
                            <input id="nai-restore-file-input" type="file" accept="application/json,.json" hidden>
                            <div class="nai-backup-actions" style="justify-content:flex-start;">
                                <button type="button" class="nai-loader-action" data-action="pick-restore-file">백업 파일 선택</button>
                            </div>
                            <div id="nai-restore-preview" class="nai-restore-preview" hidden></div>
                        </div>
                    </section>

                    <section
                        class="nai-loader-panel"
                        data-panel="settings"
                    >
                        <div class="nai-loader-section-title">
                            AI Provider
                        </div>

                        <div class="nai-provider-buttons">
                            <button
                                type="button"
                                class="nai-provider-button"
                                data-provider="gemini"
                            >
                                Gemini API
                            </button>

                            <button
                                type="button"
                                class="nai-provider-button"
                                data-provider="vertex"
                            >
                                Vertex AI
                            </button>

                            <button
                                type="button"
                                class="nai-provider-button"
                                data-provider="firebase"
                            >
                                Firebase
                            </button>
                        </div>

                        <div
                            class="nai-provider-section"
                            data-provider-section="gemini"
                        >
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Gemini API Key
                                </label>

                                <input
                                    id="nai-settings-gemini-key"
                                    class="nai-loader-input"
                                    type="password"
                                    autocomplete="off"
                                    placeholder="API Key"
                                >
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">Model</label>

                                <select
                                    id="nai-settings-gemini-model"
                                    class="nai-loader-select"
                                >
                                    <option value="gemini-3.8-flash">Gemini 3.8 Flash — 권장 · 무료</option>
                                    <option value="gemini-3.7-flash">Gemini 3.7 Flash — 이전 안정판 · 무료</option>
                                    <option value="gemini-3.6-flash">Gemini 3.6 Flash — 무료</option>
                                    <option value="gemini-3.5-flash">Gemini 3.5 Flash — 무료</option>
                                    <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview — 정밀 · 유료</option>
                                    <option value="gemini-2.5-flash">Gemini 2.5 Flash — 호환 · 무료</option>
                                </select>
                            </div>
                        </div>

                        <div
                            class="nai-provider-section"
                            data-provider-section="vertex"
                        >
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Service Account JSON
                                </label>

                                <textarea
                                    id="nai-settings-vertex-json"
                                    class="nai-loader-textarea"
                                    placeholder='{"type":"service_account", ...}'
                                ></textarea>
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Project ID
                                </label>

                                <input
                                    id="nai-settings-vertex-project"
                                    class="nai-loader-input"
                                    type="text"
                                    placeholder="비워두면 JSON의 project_id 사용"
                                >
                            </div>

                            <div class="nai-loader-row">
                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Location
                                    </label>

                                    <input
                                        id="nai-settings-vertex-location"
                                        class="nai-loader-input"
                                        type="text"
                                        placeholder="global"
                                    >
                                </div>

                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Model
                                    </label>

                                    <select
                                        id="nai-settings-vertex-model"
                                        class="nai-loader-select"
                                    >
                                        <option value="gemini-3.8-flash">Gemini 3.8 Flash — 권장</option>
                                        <option value="gemini-3.7-flash">Gemini 3.7 Flash — 이전 안정판</option>
                                        <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview — 정밀</option>
                                        <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                                        <option value="gemini-2.5-flash">Gemini 2.5 Flash — 호환</option>
                                    </select>
                                </div>
                            </div>
                        </div>

                        <div
                            class="nai-provider-section"
                            data-provider-section="firebase"
                        >
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Firebase Config
                                </label>

                                <textarea
                                    id="nai-settings-firebase-config"
                                    class="nai-loader-textarea"
                                    placeholder='firebaseConfig = {
    apiKey: "...",
    projectId: "...",
    ...
}'
                                ></textarea>
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">
                                    Firebase AI Backend
                                </label>

                                <select
                                    id="nai-settings-firebase-backend"
                                    class="nai-loader-select"
                                >
                                    <option value="vertex">
                                        Vertex AI backend
                                    </option>
                                    <option value="googleai">
                                        Gemini Developer API backend
                                    </option>
                                </select>
                            </div>

                            <div class="nai-loader-row">
                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Location
                                    </label>

                                    <input
                                        id="nai-settings-firebase-location"
                                        class="nai-loader-input"
                                        type="text"
                                        placeholder="global"
                                    >
                                </div>

                                <div class="nai-loader-field nai-loader-grow">
                                    <label class="nai-loader-label">
                                        Model
                                    </label>
                                        Model
                                    </label>

                                    <select
                                        id="nai-settings-firebase-model"
                                        class="nai-loader-select"
                                    >
                                        <option value="gemini-3.8-flash">Gemini 3.8 Flash — 권장</option>
                                        <option value="gemini-3.7-flash">Gemini 3.7 Flash — 이전 안정판</option>
                                        <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
                                        <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview — 정밀</option>
                                        <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                                        <option value="gemini-2.5-flash">Gemini 2.5 Flash — 호환</option>
                                    </select>
                                </div>
                            </div>
                        </div>


                        <div class="nai-loader-row nai-settings-action-row">
                            <button
                                type="button"
                                class="nai-loader-action"
                                data-action="test-settings"
                            >
                                연결 테스트
                            </button>

                            <button
                                type="button"
                                class="nai-loader-action primary"
                                data-action="save-settings"
                            >
                                설정 저장
                            </button>
                        </div>

                        <div
                            id="nai-settings-status"
                            class="nai-loader-status"
                        ></div>

                        <div class="nai-loader-divider"></div>

                        <div class="nai-loader-row" style="justify-content:flex-start;">
                            <button
                                type="button"
                                class="nai-loader-action danger"
                                data-action="reset-archive"
                            >
                                전체 초기화
                            </button>
                        </div>

                        <div class="nai-loader-divider"></div>

                        <div class="nai-loader-muted">
                            기본 권장 모델은 ${DEFAULT_MODEL}. 모델은 위 드롭다운의 지원 목록에서 선택합니다.<br>
                            인증정보는 이 유저스크립트의 GM 저장소에 저장되며
                            GitHub 코드에 자동으로 포함되지 않습니다.
                        </div>
                    </section>
                </div>
            </div>
            <div
                id="nai-loader-toast"
                class="nai-loader-toast"
                role="status"
                aria-live="polite"
                aria-atomic="true"
            ></div>
        `;

        document.body.appendChild(overlay);

        const $ = selector => overlay.querySelector(selector);
        const $$ = selector => [...overlay.querySelectorAll(selector)];

        let toastHideTimer = null;
        let toastSerial = 0;

        function transientStatusTone(message) {
            const value = String(message || '');
            return /(실패|오류|못했습니다|찾지 못|입력해주세요|사용할 수 없습니다|이미 있습니다|중단|올바른|http\/https)/i.test(value)
                ? 'error'
                : 'info';
        }

        function showToast(message, tone = 'info') {
            const toast = $('#nai-loader-toast');
            const value = String(message || '').trim();
            if (!toast || !value) return;

            if (toastHideTimer) clearTimeout(toastHideTimer);
            const serial = ++toastSerial;

            toast.textContent = value;
            toast.classList.toggle('error', tone === 'error');
            toast.classList.remove('show');

            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    if (serial !== toastSerial || !toast.isConnected) return;
                    toast.classList.add('show');
                });
            });

            const duration = tone === 'error' ? 3600 : 2300;
            toastHideTimer = setTimeout(() => {
                if (serial !== toastSerial || !toast.isConnected) return;
                toast.classList.remove('show');
            }, duration);
        }

        function bridgeTransientStatusToToast(status) {
            if (!status) return;
            const flush = () => {
                const message = String(status.textContent || '').trim();
                if (!message) return;
                showToast(message, transientStatusTone(message));
            };
            const observer = new MutationObserver(flush);
            observer.observe(status, {
                childList: true,
                characterData: true,
                subtree: true
            });
            flush();
        }

        [
            '#nai-manual-status',
            '#nai-library-status',
            '#nai-resource-status',
            '#nai-memo-status'
        ].forEach(selector => bridgeTransientStatusToToast($(selector)));

        function providerLabel(provider) {
            if (provider === 'gemini') return 'Gemini API';
            if (provider === 'vertex') return 'Vertex AI';
            if (provider === 'firebase') return 'Firebase';
            return provider;
        }

        function switchTab(tab) {
            if (activeTab === 'library' && libraryCreateOpen && tab !== 'library') {
                syncManualDraftFromDom();
            }

            activeTab = tab;

            $$('.nai-loader-tab').forEach(button => {
                button.classList.toggle(
                    'active',
                    button.dataset.tab === tab
                );
            });

            $$('.nai-loader-panel').forEach(panel => {
                panel.classList.toggle(
                    'active',
                    panel.dataset.panel === tab
                );
            });

            if (tab === 'library') {
                renderLibrary();
            }

            if (tab === 'resources') {
                renderResources();
            }

            if (tab === 'memos') {
                renderMemos();
            }

            if (tab === 'import') {
                renderShareImportPreview();
            }

            if (tab === 'backup') {
                renderBackupSelection();
                renderRestorePreview();
            }
        }

        function backupKindItems(kind) {
            if (kind === 'library') return getLibrary();
            if (kind === 'resources') return getResources();
            if (kind === 'memos') return getMemos();
            return [];
        }

        function backupItemLabel(kind, item) {
            if (kind === 'library') {
                return String(item?.name || item?.suggestedName || '이름 없는 컨셉').trim() || '이름 없는 컨셉';
            }
            if (kind === 'resources') {
                return String(item?.name || item?.url || '이름 없는 자료').trim() || '이름 없는 자료';
            }
            if (kind === 'memos') {
                const title = String(item?.title || '').trim();
                if (title) return title;
                const preview = String(item?.content || '').trim().replace(/\s+/g, ' ').slice(0, 42);
                return preview || '내용 없는 메모';
            }
            return '항목';
        }

        function ensureBackupSelectionInitialized() {
            const kinds = ['library', 'resources', 'memos'];
            if (!backupSelectionInitialized) {
                for (const kind of kinds) {
                    backupItemSelection[kind] = new Set(
                        backupKindItems(kind).map(item => String(item?.id || '')).filter(Boolean)
                    );
                }
                backupSelectionInitialized = true;
                return;
            }

            for (const kind of kinds) {
                const validIds = new Set(
                    backupKindItems(kind).map(item => String(item?.id || '')).filter(Boolean)
                );
                for (const id of [...backupItemSelection[kind]]) {
                    if (!validIds.has(id)) backupItemSelection[kind].delete(id);
                }
            }
        }

        function renderBackupSelection() {
            const root = $('#nai-backup-item-sections');
            if (!root) return;
            ensureBackupSelectionInitialized();

            root.innerHTML = ['library', 'resources', 'memos'].map(kind => {
                const items = backupKindItems(kind);
                const selected = backupItemSelection[kind];
                const rows = items.length
                    ? items.map(item => {
                        const id = String(item?.id || '');
                        const checked = selected.has(id);
                        return `
                            <label class="nai-backup-item" title="${escapeHtml(backupItemLabel(kind, item))}">
                                <input
                                    type="checkbox"
                                    data-backup-item-kind="${kind}"
                                    data-backup-item-id="${escapeHtml(id)}"
                                    ${checked ? 'checked' : ''}
                                >
                                <span class="nai-backup-item-label">${escapeHtml(backupItemLabel(kind, item))}</span>
                            </label>
                        `;
                    }).join('')
                    : '<div class="nai-backup-empty">저장된 항목이 없습니다.</div>';

                return `
                    <div class="nai-backup-section" data-backup-section="${kind}">
                        <div class="nai-backup-section-head">
                            <span class="nai-backup-section-title">${restoreKindLabel(kind)}</span>
                            <span class="nai-backup-section-count">${selected.size}/${items.length}</span>
                            <div class="nai-backup-section-controls">
                                <button type="button" class="nai-loader-action" data-backup-select-all="${kind}">전체 선택</button>
                                <button type="button" class="nai-loader-action" data-backup-clear-all="${kind}">전체 해제</button>
                            </div>
                        </div>
                        <div class="nai-backup-item-list">${rows}</div>
                    </div>
                `;
            }).join('');
        }

        function backupSelectedCount() {
            return ['library', 'resources', 'memos']
                .reduce((sum, kind) => sum + backupItemSelection[kind].size, 0);
        }

        function downloadBackupFile() {
            ensureBackupSelectionInitialized();
            const selectedCount = backupSelectedCount();
            if (!selectedCount) {
                showToast('백업할 항목을 하나 이상 선택해주세요.', 'error');
                return;
            }

            const payload = createArchiveBackupPayload(backupItemSelection);
            const json = JSON.stringify(payload, null, 2);
            const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
            link.href = objectUrl;
            link.download = `NAI-Archive-backup-${stamp}.json`;
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
            showToast(`선택한 ${selectedCount}개 항목을 백업했습니다.`);
        }

        function restoreKindLabel(kind) {
            if (kind === 'library') return '라이브러리';
            if (kind === 'resources') return '자료실';
            if (kind === 'memos') return '메모';
            return kind;
        }

        function renderRestorePreview() {
            const preview = $('#nai-restore-preview');
            if (!preview) return;

            if (!restoreDraft?.backup) {
                preview.hidden = true;
                preview.innerHTML = '';
                return;
            }

            const inspection = inspectArchiveRestore(restoreDraft.backup);
            const availableKinds = ['library', 'resources', 'memos'].filter(
                kind => !!restoreDraft.backup.sections?.[kind]
            );
            const summaryRows = availableKinds.map(kind => {
                const stat = inspection[kind] || { total: 0, duplicate: 0, addable: 0, invalid: 0 };
                const extras = [];
                if (stat.duplicate) extras.push(`중복 ${stat.duplicate}개 제외`);
                if (stat.invalid) extras.push(`유효하지 않음 ${stat.invalid}개 제외`);
                return `<div><strong>${restoreKindLabel(kind)}</strong> ${stat.total}개 · 복원 예정 ${stat.addable}개${extras.length ? ` · ${extras.join(' · ')}` : ''}</div>`;
            }).join('');

            preview.hidden = false;
            preview.innerHTML = `
                <div class="nai-restore-file-name">${escapeHtml(restoreDraft.fileName || '백업 파일')}</div>
                <div class="nai-loader-muted">복원할 항목을 선택하세요.</div>
                <div class="nai-backup-choice-row">
                    ${availableKinds.map(kind => `
                        <button
                            type="button"
                            class="nai-library-category-chip nai-backup-choice${restoreDraft.selected.has(kind) ? ' active' : ''}"
                            data-restore-kind="${kind}"
                        >${restoreKindLabel(kind)}</button>
                    `).join('')}
                </div>
                <div class="nai-restore-summary">${summaryRows}</div>
                <div class="nai-edit-footer-actions" style="margin-top:12px;">
                    <button type="button" class="nai-loader-action" data-action="cancel-restore-preview">취소</button>
                    <button type="button" class="nai-loader-action primary" data-action="run-restore">복원 실행</button>
                </div>
            `;
        }

        async function loadRestoreFile(file) {
            if (!file) return;
            try {
                const rawText = await file.text();
                const backup = parseArchiveBackupPayload(rawText);
                const availableKinds = ['library', 'resources', 'memos'].filter(
                    kind => !!backup.sections?.[kind]
                );
                restoreDraft = {
                    fileName: file.name || '백업 파일',
                    backup,
                    selected: new Set(availableKinds)
                };
                renderRestorePreview();
            } catch (error) {
                restoreDraft = null;
                renderRestorePreview();
                showToast(`백업 파일 읽기 실패: ${error?.message || String(error)}`, 'error');
            } finally {
                const input = $('#nai-restore-file-input');
                if (input) input.value = '';
            }
        }

        function runRestore() {
            if (!restoreDraft?.backup) {
                showToast('먼저 백업 파일을 선택해주세요.', 'error');
                return;
            }
            if (!restoreDraft.selected.size) {
                showToast('복원할 항목을 하나 이상 선택해주세요.', 'error');
                return;
            }

            const result = restoreArchiveBackup(restoreDraft.backup, [...restoreDraft.selected]);
            const parts = [];
            for (const kind of ['library', 'resources', 'memos']) {
                if (!restoreDraft.selected.has(kind) || !restoreDraft.backup.sections?.[kind]) continue;
                const item = result[kind];
                const skipped = item.duplicate + item.invalid;
                parts.push(`${restoreKindLabel(kind)} ${item.added}개${skipped ? ` (제외 ${skipped}개)` : ''}`);
            }

            restoreDraft = null;
            renderRestorePreview();
            renderLibrary();
            renderResources();
            renderMemos();
            showToast(`복원 완료 · ${parts.join(' / ')}`);
        }

        function updateProviderUI() {
            $('#nai-backup-item-sections')?.addEventListener('change', event => {
                const input = event.target.closest('input[data-backup-item-kind][data-backup-item-id]');
                if (!input) return;
                const kind = input.dataset.backupItemKind;
                const id = input.dataset.backupItemId;
                if (!backupItemSelection[kind] || !id) return;
                if (input.checked) backupItemSelection[kind].add(id);
                else backupItemSelection[kind].delete(id);
                renderBackupSelection();
            });

            $('#nai-backup-item-sections')?.addEventListener('click', event => {
                const selectAll = event.target.closest('[data-backup-select-all]');
                if (selectAll) {
                    const kind = selectAll.dataset.backupSelectAll;
                    backupItemSelection[kind] = new Set(
                        backupKindItems(kind).map(item => String(item?.id || '')).filter(Boolean)
                    );
                    renderBackupSelection();
                    return;
                }

                const clearAll = event.target.closest('[data-backup-clear-all]');
                if (clearAll) {
                    const kind = clearAll.dataset.backupClearAll;
                    backupItemSelection[kind]?.clear();
                    renderBackupSelection();
                }
            });

        $('[data-action="create-backup-file"]')?.addEventListener('click', downloadBackupFile);

        $('[data-action="pick-restore-file"]')?.addEventListener('click', () => {
            $('#nai-restore-file-input')?.click();
        });

        $('#nai-restore-file-input')?.addEventListener('change', event => {
            loadRestoreFile(event.target.files?.[0] || null);
        });

        $('#nai-restore-preview')?.addEventListener('click', event => {
            const button = event.target.closest('button');
            if (!button) return;

            if (button.matches('[data-restore-kind]')) {
                const kind = button.dataset.restoreKind;
                if (!restoreDraft?.selected) return;
                if (restoreDraft.selected.has(kind)) restoreDraft.selected.delete(kind);
                else restoreDraft.selected.add(kind);
                renderRestorePreview();
                return;
            }

            if (button.dataset.action === 'cancel-restore-preview') {
                restoreDraft = null;
                renderRestorePreview();
                return;
            }

            if (button.dataset.action === 'run-restore') {
                runRestore();
            }
        });

        $$('.nai-provider-button').forEach(button => {
                button.classList.toggle(
                    'active',
                    button.dataset.provider === currentProvider
                );
            });

            $$('.nai-provider-section').forEach(section => {
                section.classList.toggle(
                    'active',
                    section.dataset.providerSection === currentProvider
                );
            });
        }

        const MODEL_PRESETS = new Set([
            'gemini-3.8-flash',
            'gemini-3.7-flash',
            'gemini-3.6-flash',
            'gemini-3.1-pro-preview',
            'gemini-3.5-flash',
            'gemini-2.5-flash'
        ]);

        function loadModelPicker(selectSelector, value) {
            const model = String(value || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
            const select = $(selectSelector);
            select.value = MODEL_PRESETS.has(model) ? model : DEFAULT_MODEL;
        }

        function readModelPicker(selectSelector) {
            return $(selectSelector).value || DEFAULT_MODEL;
        }

        function loadSettingsIntoForm() {
            const settings = getSettings();

            currentProvider = settings.provider || 'gemini';

            $('#nai-settings-gemini-key').value =
                settings.geminiKey || '';

            loadModelPicker(
                '#nai-settings-gemini-model',
                settings.geminiModel
            );

            $('#nai-settings-vertex-json').value =
                settings.vertexJson || '';

            $('#nai-settings-vertex-project').value =
                settings.vertexProjectId || '';

            $('#nai-settings-vertex-location').value =
                settings.vertexLocation || 'global';

            loadModelPicker(
                '#nai-settings-vertex-model',
                settings.vertexModel
            );

            $('#nai-settings-firebase-config').value =
                settings.firebaseConfig || '';

            $('#nai-settings-firebase-backend').value =
                settings.firebaseBackend || 'vertex';

            $('#nai-settings-firebase-location').value =
                settings.firebaseLocation || 'global';

            loadModelPicker(
                '#nai-settings-firebase-model',
                settings.firebaseModel
            );

            updateProviderUI();
        }

        function collectSettingsFromForm() {
            return {
                provider: currentProvider,

                geminiKey:
                    $('#nai-settings-gemini-key').value.trim(),

                geminiModel: readModelPicker(
                    '#nai-settings-gemini-model'
                ),

                vertexJson:
                    $('#nai-settings-vertex-json').value.trim(),

                vertexProjectId:
                    $('#nai-settings-vertex-project').value.trim(),

                vertexLocation:
                    $('#nai-settings-vertex-location').value.trim() ||
                    'global',

                vertexModel: readModelPicker(
                    '#nai-settings-vertex-model'
                ),

                firebaseConfig:
                    $('#nai-settings-firebase-config').value.trim(),

                firebaseBackend:
                    $('#nai-settings-firebase-backend').value ||
                    'vertex',

                firebaseLocation:
                    $('#nai-settings-firebase-location').value.trim() ||
                    'global',

                firebaseModel: readModelPicker(
                    '#nai-settings-firebase-model'
                )
            };
        }

        function setCreatePanelOpen(kind, open) {
            const nextOpen = !!open;
            let wrap = null;
            let toggle = null;

            if (kind === 'library') {
                libraryCreateOpen = nextOpen;
                wrap = $('#nai-library-create-wrap');
                toggle = $('[data-create-toggle="library"]');
                if (nextOpen) renderManualAddEditor();
            } else if (kind === 'resources') {
                resourceCreateOpen = nextOpen;
                wrap = $('#nai-resource-create-wrap');
                toggle = $('[data-create-toggle="resources"]');
                if (nextOpen) renderResourceCreateCategoryAssignment();
            } else if (kind === 'memos') {
                memoCreateOpen = nextOpen;
                wrap = $('#nai-memo-create-wrap');
                toggle = $('[data-create-toggle="memos"]');
                if (nextOpen) renderMemoCreateCategoryAssignment();
            }

            if (wrap) wrap.hidden = !nextOpen;
            if (toggle) {
                toggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                toggle.classList.toggle('primary', nextOpen);
            }
        }

        function clearResourceCreateForm() {
            if ($('#nai-resource-name')) $('#nai-resource-name').value = '';
            if ($('#nai-resource-url')) $('#nai-resource-url').value = '';
            if ($('#nai-resource-note')) $('#nai-resource-note').value = '';
            resourceCreateCategories.clear();
            renderResourceCreateCategoryAssignment();
        }

        function clearMemoCreateForm() {
            if ($('#nai-memo-title')) $('#nai-memo-title').value = '';
            if ($('#nai-memo-content')) $('#nai-memo-content').value = '';
            memoCreateCategories.clear();
            renderMemoCreateCategoryAssignment();
        }

        function getInfoCategoryConfig(kind) {
            if (kind === 'resources') {
                return {
                    kind,
                    label: '자료실',
                    bar: '#nai-resource-category-bar',
                    status: '#nai-resource-status',
                    getCategories: getResourceCategories,
                    saveCategories: saveResourceCategories,
                    getItems: getResources,
                    saveItems: saveResources,
                    normalizeItem: normalizeResourceRecord,
                    active: activeResourceCategories,
                    getEditMode: () => resourceCategoryEditMode,
                    setEditMode: value => { resourceCategoryEditMode = !!value; },
                    getEditingDraft: () => resourceEditingDraft,
                    setEditingDraft: value => { resourceEditingDraft = value; },
                    render: renderResources
                };
            }

            return {
                kind: 'memos',
                label: '메모',
                bar: '#nai-memo-category-bar',
                status: '#nai-memo-status',
                getCategories: getMemoCategories,
                saveCategories: saveMemoCategories,
                getItems: getMemos,
                saveItems: saveMemos,
                normalizeItem: normalizeMemoRecord,
                active: activeMemoCategories,
                getEditMode: () => memoCategoryEditMode,
                setEditMode: value => { memoCategoryEditMode = !!value; },
                getEditingDraft: () => memoEditingDraft,
                setEditingDraft: value => { memoEditingDraft = value; },
                render: renderMemos
            };
        }

        function renderInfoCategoryBar(kind) {
            const config = getInfoCategoryConfig(kind);
            const bar = $(config.bar);
            if (!bar) return;

            const categories = config.getCategories();
            const valid = new Set(categories);
            [...config.active].forEach(name => {
                if (!valid.has(name)) config.active.delete(name);
            });

            const filters = [
                `<button type="button" class="nai-library-category-chip${config.active.size ? '' : ' active'}" data-info-category-filter="__all__" data-info-category-scope="${config.kind}">전체</button>`
            ];

            categories.forEach(name => {
                filters.push(
                    `<button type="button" class="nai-library-category-chip${config.active.has(name) ? ' active' : ''}" data-info-category-filter="${escapeHtml(name)}" data-info-category-scope="${config.kind}">${escapeHtml(name)}</button>`
                );
            });

            const editMode = config.getEditMode();
            const manager = editMode ? `
                <div class="nai-library-category-manager" data-info-category-manager="${config.kind}">
                    ${categories.length ? categories.map((name, index) => `
                        <div class="nai-library-category-manager-row" data-info-category-manager-row="${escapeHtml(name)}">
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-info-category-move="up"
                                data-info-category-name="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                                title="위로 이동"
                                ${index === 0 ? 'disabled' : ''}
                            >↑</button>
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-info-category-move="down"
                                data-info-category-name="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                                title="아래로 이동"
                                ${index === categories.length - 1 ? 'disabled' : ''}
                            >↓</button>
                            <input
                                type="text"
                                class="nai-loader-input nai-loader-grow"
                                value="${escapeHtml(name)}"
                                data-info-category-rename="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                                aria-label="${escapeHtml(name)} 분류 이름"
                            >
                            <button
                                type="button"
                                class="nai-library-category-manager-button danger"
                                data-info-category-delete="${escapeHtml(name)}"
                                data-info-category-scope="${config.kind}"
                            >삭제</button>
                        </div>
                    `).join('') : '<div class="nai-library-category-empty">아직 만든 분류가 없습니다.</div>'}
                </div>
            ` : '';

            bar.innerHTML = `
                <div class="nai-library-category-filter-group">
                    ${filters.join('')}
                </div>
                <div class="nai-library-category-tools">
                    <button
                        type="button"
                        class="nai-library-category-chip nai-library-category-edit-button${editMode ? ' active' : ''}"
                        data-info-category-edit-toggle
                        data-info-category-scope="${config.kind}"
                        aria-expanded="${editMode ? 'true' : 'false'}"
                    >${editMode ? '완료' : '수정'}</button>
                    <button
                        type="button"
                        class="nai-library-category-chip nai-category-add"
                        data-info-category-add
                        data-info-category-scope="${config.kind}"
                        title="새 분류 추가"
                        aria-label="새 분류 추가"
                    >+</button>
                </div>
                ${manager}
            `;
        }

        function renderInfoCategoryAssignment(kind, item) {
            const config = getInfoCategoryConfig(kind);
            const categories = config.getCategories();
            if (!categories.length) return '';

            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-info-category-assign="${escapeHtml(name)}"
                    data-info-category-scope="${config.kind}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderResourceSelectedCategoryBadges(item) {
            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            if (!selected.size) return '';
            const categories = getResourceCategories();
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...[...selected].filter(name => !categories.includes(name))
            ];
            return ordered.map(name =>
                `<span class="nai-resource-category-badge">${escapeHtml(name)}</span>`
            ).join('');
        }

        function renderResourceCreateCategoryAssignment() {
            const row = $('#nai-resource-create-categories');
            if (!row) return;

            const categories = getResourceCategories();
            const valid = new Set(categories);
            [...resourceCreateCategories].forEach(name => {
                if (!valid.has(name)) resourceCreateCategories.delete(name);
            });

            if (!categories.length) {
                row.innerHTML = '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
                return;
            }

            const ordered = [
                ...categories.filter(name => resourceCreateCategories.has(name)),
                ...categories.filter(name => !resourceCreateCategories.has(name))
            ];

            row.innerHTML = ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${resourceCreateCategories.has(name) ? ' active' : ''}"
                    data-resource-create-category="${escapeHtml(name)}"
                    aria-pressed="${resourceCreateCategories.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderManualCreateCategoryAssignmentHtml() {
            const categories = getLibraryCategories();
            const selected = new Set(normalizeLibraryCategoryList(manualDraft?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];
            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-manual-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderManualCreateCategoryAssignment() {
            const row = $('#nai-manual-create-categories');
            if (!row) return;

            const categories = getLibraryCategories();
            const selected = new Set(normalizeLibraryCategoryList(manualDraft?.categories));
            const valid = new Set(categories);
            [...selected].forEach(name => {
                if (!valid.has(name)) selected.delete(name);
            });
            manualDraft.categories = normalizeLibraryCategoryList([...selected]);

            if (!categories.length) {
                row.innerHTML = '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
                return;
            }

            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            row.innerHTML = ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-manual-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderMemoCreateCategoryAssignment() {
            const row = $('#nai-memo-create-categories');
            if (!row) return;

            const categories = getMemoCategories();
            const valid = new Set(categories);
            [...memoCreateCategories].forEach(name => {
                if (!valid.has(name)) memoCreateCategories.delete(name);
            });

            if (!categories.length) {
                row.innerHTML = '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
                return;
            }

            const ordered = [
                ...categories.filter(name => memoCreateCategories.has(name)),
                ...categories.filter(name => !memoCreateCategories.has(name))
            ];

            row.innerHTML = ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${memoCreateCategories.has(name) ? ' active' : ''}"
                    data-memo-create-category="${escapeHtml(name)}"
                    aria-pressed="${memoCreateCategories.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderMemoSelectedCategoryBadges(item) {
            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            if (!selected.size) return '';
            const categories = getMemoCategories();
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...[...selected].filter(name => !categories.includes(name))
            ];
            return ordered.map(name =>
                `<span class="nai-memo-category-badge">${escapeHtml(name)}</span>`
            ).join('');
        }

        function saveVisibleMemoOrder(orderedVisibleIds) {
            const memos = getMemos();
            if (!memos.length) return false;

            const byId = new Map(memos.map(item => [item.id, item]));
            const visibleSet = new Set(
                visibleMemoIds.filter(id => byId.has(id))
            );
            if (visibleSet.size < 2) return false;

            const nextVisibleOrder = [];
            orderedVisibleIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });
            visibleMemoIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });

            let cursor = 0;
            const reordered = memos.map(item => {
                if (!visibleSet.has(item.id)) return item;
                const nextId = nextVisibleOrder[cursor++];
                return byId.get(nextId) || item;
            });

            saveMemos(reordered);
            return true;
        }

        function saveVisibleResourceOrder(orderedVisibleIds) {
            const resources = getResources();
            if (!resources.length) return false;

            const byId = new Map(resources.map(item => [item.id, item]));
            const visibleSet = new Set(
                visibleResourceIds.filter(id => byId.has(id))
            );
            if (visibleSet.size < 2) return false;

            const nextVisibleOrder = [];
            orderedVisibleIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });
            visibleResourceIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });

            let cursor = 0;
            const reordered = resources.map(item => {
                if (!visibleSet.has(item.id)) return item;
                const nextId = nextVisibleOrder[cursor++];
                return byId.get(nextId) || item;
            });

            saveResources(reordered);
            return true;
        }

        function renameInfoCategory(kind, oldName, rawNewName) {
            const config = getInfoCategoryConfig(kind);
            const previous = normalizeLibraryCategoryName(oldName);
            const next = normalizeLibraryCategoryName(rawNewName);
            if (!previous) return false;

            if (!next || next === '전체' || next === '+') {
                $(config.status).textContent = '이 이름은 분류로 사용할 수 없습니다.';
                config.render();
                return false;
            }
            if (previous === next) return true;

            const categories = config.getCategories();
            if (categories.includes(next)) {
                $(config.status).textContent = `"${next}" 분류는 이미 있습니다.`;
                config.render();
                return false;
            }

            const categoryIndex = categories.indexOf(previous);
            if (categoryIndex < 0) return false;
            categories[categoryIndex] = next;
            config.saveCategories(categories);

            const items = config.getItems().map(rawItem => {
                const item = config.normalizeItem(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).map(name => name === previous ? next : name)
                    )
                };
            });
            config.saveItems(items);

            if (config.active.delete(previous)) config.active.add(next);

            const draft = config.getEditingDraft();
            if (draft?.categories) {
                config.setEditingDraft({
                    ...draft,
                    categories: normalizeLibraryCategoryList(
                        draft.categories.map(name => name === previous ? next : name)
                    )
                });
            }

            $(config.status).textContent = `"${previous}" → "${next}"로 변경했습니다.`;
            config.render();
            return true;
        }

        function deleteInfoCategory(kind, name) {
            const config = getInfoCategoryConfig(kind);
            const target = normalizeLibraryCategoryName(name);
            if (!target) return;
            if (!window.confirm(`"${target}" 분류를 삭제할까요?\n${config.label} 항목에 지정된 이 분류도 함께 제거됩니다.`)) return;

            config.saveCategories(
                config.getCategories().filter(category => category !== target)
            );

            const items = config.getItems().map(rawItem => {
                const item = config.normalizeItem(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).filter(category => category !== target)
                    )
                };
            });
            config.saveItems(items);
            config.active.delete(target);

            const draft = config.getEditingDraft();
            if (draft?.categories) {
                config.setEditingDraft({
                    ...draft,
                    categories: normalizeLibraryCategoryList(
                        draft.categories.filter(category => category !== target)
                    )
                });
            }

            $(config.status).textContent = `"${target}" 분류를 삭제했습니다.`;
            config.render();
        }

        function moveInfoCategory(kind, name, direction) {
            const config = getInfoCategoryConfig(kind);
            const target = normalizeLibraryCategoryName(name);
            const categories = config.getCategories();
            const index = categories.indexOf(target);
            if (index < 0) return;

            const nextIndex = direction === 'up' ? index - 1 : index + 1;
            if (nextIndex < 0 || nextIndex >= categories.length) return;

            [categories[index], categories[nextIndex]] = [categories[nextIndex], categories[index]];
            config.saveCategories(categories);
            config.render();
        }

        function handleInfoCategoryBarClick(event) {
            const control = event.target.closest('[data-info-category-scope]');
            if (!control) return;
            const kind = control.dataset.infoCategoryScope;
            if (kind !== 'resources' && kind !== 'memos') return;
            const config = getInfoCategoryConfig(kind);

            if (control.matches('[data-info-category-edit-toggle]')) {
                config.setEditMode(!config.getEditMode());
                config.render();
                return;
            }

            if (control.matches('[data-info-category-add]')) {
                const raw = window.prompt('새 분류 이름');
                if (raw === null) return;
                const name = normalizeLibraryCategoryName(raw);
                if (!name || name === '전체' || name === '+') {
                    $(config.status).textContent = '이 이름은 분류로 사용할 수 없습니다.';
                    return;
                }
                const categories = config.getCategories();
                if (categories.includes(name)) {
                    $(config.status).textContent = `"${name}" 분류는 이미 있습니다.`;
                    return;
                }
                categories.push(name);
                config.saveCategories(categories);
                config.render();
                $(config.status).textContent = `"${name}" 분류를 추가했습니다.`;
                return;
            }

            if (control.matches('[data-info-category-move]')) {
                moveInfoCategory(kind, control.dataset.infoCategoryName, control.dataset.infoCategoryMove);
                return;
            }

            if (control.matches('[data-info-category-delete]')) {
                deleteInfoCategory(kind, control.dataset.infoCategoryDelete);
                return;
            }

            if (control.matches('[data-info-category-filter]')) {
                const name = control.dataset.infoCategoryFilter;
                if (name === '__all__') config.active.clear();
                else if (config.active.has(name)) config.active.delete(name);
                else config.active.add(name);
                config.render();
            }
        }

        function handleInfoCategoryAssignment(button) {
            const kind = button.dataset.infoCategoryScope;
            const name = normalizeLibraryCategoryName(button.dataset.infoCategoryAssign);
            if (!name || (kind !== 'resources' && kind !== 'memos')) return false;
            const config = getInfoCategoryConfig(kind);
            const cardSelector = kind === 'resources' ? '[data-resource-id]' : '[data-memo-id]';
            const idKey = kind === 'resources' ? 'resourceId' : 'memoId';
            const card = button.closest(cardSelector);
            const id = card?.dataset[idKey];
            if (!id) return false;

            if (kind === 'resources' && resourceEditingId === id) syncResourceEditDraftFromDom();
            if (kind === 'memos' && memoEditingId === id) syncMemoEditDraftFromDom();

            const items = config.getItems();
            const index = items.findIndex(item => item.id === id);
            if (index < 0) return false;
            const item = config.normalizeItem(items[index]);

            const draft = config.getEditingDraft();
            const sourceCategories = draft?.id === id ? draft.categories : item.categories;
            const selected = new Set(normalizeLibraryCategoryList(sourceCategories));
            if (selected.has(name)) selected.delete(name);
            else selected.add(name);
            const nextCategories = normalizeLibraryCategoryList([...selected]);

            if (draft?.id === id) {
                config.setEditingDraft({ ...draft, categories: nextCategories });
            }

            items[index] = {
                ...item,
                categories: nextCategories,
                updatedAt: Date.now()
            };
            config.saveItems(items);
            config.render();
            return true;
        }

        function renderResources() {
            renderInfoCategoryBar('resources');
            if (resourceCreateOpen) renderResourceCreateCategoryAssignment();
            const query = String($('#nai-resource-search')?.value || '').trim().toLowerCase();
            const resources = getResources();
            const filtered = resources.filter(rawItem => {
                const item = normalizeResourceRecord(rawItem);
                const itemCategories = new Set(item.categories || []);
                if (![...activeResourceCategories].every(name => itemCategories.has(name))) return false;
                if (!query) return true;
                return [item.name, item.url, item.note]
                    .filter(Boolean)
                    .some(value => String(value).toLowerCase().includes(query));
            });
            const list = $('#nai-resource-list');
            if (!list) return;
            visibleResourceIds = filtered.map(rawItem => normalizeResourceRecord(rawItem).id);

            if (!filtered.length) {
                visibleResourceIds = [];
                list.innerHTML = `<div class="nai-library-empty">${resources.length ? '검색/분류 결과가 없습니다.' : '아직 저장한 자료가 없습니다.'}</div>`;
                return;
            }

            list.innerHTML = filtered.map(rawItem => {
                const item = normalizeResourceRecord(rawItem);
                const isEditing = resourceEditingId === item.id;
                if (isEditing) {
                    if (!resourceEditingDraft || resourceEditingDraft.id !== item.id) {
                        resourceEditingDraft = { ...item };
                    }
                    const draft = resourceEditingDraft;
                    return `
                        <article class="nai-info-card nai-info-edit-card" data-resource-id="${escapeHtml(item.id)}">
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">이름</label>
                                <input class="nai-loader-input" data-resource-edit-field="name" value="${escapeHtml(draft.name || '')}">
                            </div>
                            <div class="nai-loader-field nai-library-edit-category-field">
                                <label class="nai-loader-label">분류</label>
                                <div class="nai-library-card-category-row" aria-label="자료 분류">
                                    ${getResourceCategories().length
                                        ? renderInfoCategoryAssignment('resources', draft)
                                        : '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>'}
                                </div>
                            </div>
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">링크</label>
                                <input class="nai-loader-input" data-resource-edit-field="url" type="url" value="${escapeHtml(draft.url || '')}">
                            </div>
                            <div class="nai-loader-field" style="margin-bottom:0;">
                                <label class="nai-loader-label">메모 <span class="nai-loader-muted">(선택)</span></label>
                                <textarea class="nai-loader-textarea" data-resource-edit-field="note">${escapeHtml(draft.note || '')}</textarea>
                            </div>
                            <div class="nai-edit-footer-actions" style="margin-top:10px;">
                                <button type="button" class="nai-loader-action" data-resource-action="cancel-edit">취소</button>
                                <button type="button" class="nai-loader-action primary" data-resource-action="save-edit">수정 저장</button>
                            </div>
                        </article>`;
                }

                const title = item.name || fallbackResourceName(item.url);
                const selectedCategoryBadges = renderResourceSelectedCategoryBadges(item);
                return `
                    <article
                        class="nai-info-card nai-resource-card"
                        data-resource-id="${escapeHtml(item.id)}"
                        role="link"
                        tabindex="0"
                        aria-label="${escapeHtml(title)} 열기"
                        title="클릭해서 링크 열기"
                    >
                        <div class="nai-info-card-head">
                            <div class="nai-resource-title-group">
                                <button
                                    type="button"
                                    class="nai-resource-order-handle"
                                    data-resource-drag-handle
                                    title="누른 채 드래그하여 카드 순서 변경"
                                    aria-label="누른 채 드래그하여 카드 순서 변경"
                                >☰</button>
                                <div class="nai-info-card-title">${escapeHtml(title)}</div>
                            </div>
                        </div>
                        ${selectedCategoryBadges ? `
                            <div class="nai-resource-category-badges" aria-label="선택된 자료 분류">
                                ${selectedCategoryBadges}
                            </div>
                        ` : ''}
                        ${item.note ? `<div class="nai-info-note">${escapeHtml(item.note)}</div>` : ''}
                        <div class="nai-info-actions" data-resource-card-actions>
                            <button type="button" class="nai-loader-action danger" data-resource-action="delete">삭제</button>
                            <div class="nai-info-action-right">
                                <button type="button" class="nai-loader-action ghost" data-resource-action="share">공유</button>
                                <button type="button" class="nai-loader-action ghost" data-resource-action="edit">수정</button>
                            </div>
                        </div>
                    </article>`;
            }).join('');
        }

        function syncResourceEditDraftFromDom() {
            if (!resourceEditingId || !resourceEditingDraft) return;
            const card = $(`#nai-resource-list [data-resource-id="${CSS.escape(resourceEditingId)}"]`);
            if (!card) return;
            resourceEditingDraft = {
                ...resourceEditingDraft,
                name: String(card.querySelector('[data-resource-edit-field="name"]')?.value || '').trim(),
                url: String(card.querySelector('[data-resource-edit-field="url"]')?.value || '').trim(),
                note: String(card.querySelector('[data-resource-edit-field="note"]')?.value || '').trim()
            };
        }

        function addResource() {
            const status = $('#nai-resource-status');
            const url = normalizedExternalUrl($('#nai-resource-url')?.value);
            if (!url) {
                status.textContent = 'http/https 링크를 입력해주세요.';
                return;
            }
            const name = String($('#nai-resource-name')?.value || '').trim() || fallbackResourceName(url);
            const note = String($('#nai-resource-note')?.value || '').trim();
            const now = Date.now();
            const resources = getResources();
            const categories = normalizeLibraryCategoryList([...resourceCreateCategories]);
            resources.unshift({ id: createId(), name, url, note, categories, createdAt: now, updatedAt: now });
            saveResources(resources);
            clearResourceCreateForm();
            setCreatePanelOpen('resources', false);
            status.textContent = `"${name}" 자료를 저장했습니다.`;
            renderResources();
        }

        async function handleResourceAction(button) {
            const action = button.dataset.resourceAction;
            if (action === 'add') {
                addResource();
                return;
            }
            if (action === 'cancel-add') {
                clearResourceCreateForm();
                setCreatePanelOpen('resources', false);
                $('#nai-resource-status').textContent = '';
                return;
            }
            const card = button.closest('[data-resource-id]');
            const id = card?.dataset.resourceId;
            if (!id) return;
            const resources = getResources();
            const index = resources.findIndex(item => item.id === id);
            if (index < 0) return;
            const item = normalizeResourceRecord(resources[index]);
            const status = $('#nai-resource-status');

            if (action === 'open') {
                const url = normalizedExternalUrl(item.url);
                if (url) window.open(url, '_blank', 'noopener,noreferrer');
                return;
            }
            if (action === 'share') {
                try {
                    const shareCode = createResourceShareCode(item);
                    const ok = await copyText(shareCode);
                    status.textContent = ok
                        ? `"${item.name || fallbackResourceName(item.url)}" 자료 공유 코드를 클립보드에 복사했습니다.`
                        : '자료 공유 코드 클립보드 복사에 실패했습니다.';
                } catch (error) {
                    status.textContent = `자료 공유 코드 생성 실패: ${error?.message || String(error)}`;
                }
                return;
            }
            if (action === 'edit') {
                resourceEditingId = id;
                resourceEditingDraft = { ...item };
                renderResources();
                return;
            }
            if (action === 'cancel-edit') {
                resourceEditingId = null;
                resourceEditingDraft = null;
                renderResources();
                return;
            }
            if (action === 'save-edit') {
                syncResourceEditDraftFromDom();
                const url = normalizedExternalUrl(resourceEditingDraft?.url);
                if (!url) {
                    status.textContent = 'http/https 링크를 입력해주세요.';
                    return;
                }
                const name = String(resourceEditingDraft?.name || '').trim() || fallbackResourceName(url);
                resources[index] = {
                    ...item,
                    ...resourceEditingDraft,
                    name,
                    url,
                    updatedAt: Date.now()
                };
                saveResources(resources);
                resourceEditingId = null;
                resourceEditingDraft = null;
                status.textContent = `"${name}" 자료를 수정했습니다.`;
                renderResources();
                return;
            }
            if (action === 'delete') {
                resources.splice(index, 1);
                saveResources(resources);
                if (resourceEditingId === id) {
                    resourceEditingId = null;
                    resourceEditingDraft = null;
                }
                status.textContent = `"${item.name || fallbackResourceName(item.url)}" 자료를 삭제했습니다.`;
                renderResources();
            }
        }

        function renderMemos() {
            renderInfoCategoryBar('memos');
            if (memoCreateOpen) renderMemoCreateCategoryAssignment();
            const query = String($('#nai-memo-search')?.value || '').trim().toLowerCase();
            const memos = getMemos();
            const filtered = memos.filter(rawItem => {
                const item = normalizeMemoRecord(rawItem);
                const itemCategories = new Set(item.categories || []);
                if (![...activeMemoCategories].every(name => itemCategories.has(name))) return false;
                if (!query) return true;
                return [item.title, item.content]
                    .filter(Boolean)
                    .some(value => String(value).toLowerCase().includes(query));
            });
            const list = $('#nai-memo-list');
            if (!list) return;
            visibleMemoIds = filtered.map(rawItem => normalizeMemoRecord(rawItem).id);

            if (!filtered.length) {
                visibleMemoIds = [];
                list.innerHTML = `<div class="nai-library-empty">${memos.length ? '검색/분류 결과가 없습니다.' : '아직 저장한 메모가 없습니다.'}</div>`;
                return;
            }

            list.innerHTML = filtered.map(rawItem => {
                const item = normalizeMemoRecord(rawItem);
                const isEditing = memoEditingId === item.id;
                if (isEditing) {
                    if (!memoEditingDraft || memoEditingDraft.id !== item.id) {
                        memoEditingDraft = { ...item };
                    }
                    const draft = memoEditingDraft;
                    return `
                        <article class="nai-info-card nai-info-edit-card" data-memo-id="${escapeHtml(item.id)}">
                            <div class="nai-loader-field">
                                <label class="nai-loader-label">제목 <span class="nai-loader-muted">(선택)</span></label>
                                <input class="nai-loader-input" data-memo-edit-field="title" value="${escapeHtml(draft.title || '')}">
                            </div>
                            <div class="nai-loader-field nai-library-edit-category-field">
                                <label class="nai-loader-label">분류</label>
                                <div class="nai-library-card-category-row" aria-label="메모 분류">
                                    ${getMemoCategories().length
                                        ? renderInfoCategoryAssignment('memos', draft)
                                        : '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>'}
                                </div>
                            </div>
                            <div class="nai-loader-field" style="margin-bottom:0;">
                                <label class="nai-loader-label">내용</label>
                                <textarea class="nai-loader-textarea" data-memo-edit-field="content">${escapeHtml(draft.content || '')}</textarea>
                            </div>
                            <div class="nai-edit-footer-actions" style="margin-top:10px;">
                                <button type="button" class="nai-loader-action" data-memo-action="cancel-edit">취소</button>
                                <button type="button" class="nai-loader-action primary" data-memo-action="save-edit">수정 저장</button>
                            </div>
                        </article>`;
                }

                const selectedCategoryBadges = renderMemoSelectedCategoryBadges(item);
                return `
                    <article class="nai-info-card nai-memo-card" data-memo-id="${escapeHtml(item.id)}">
                        <div class="nai-info-card-head">
                            <div class="nai-memo-title-group">
                                <button
                                    type="button"
                                    class="nai-memo-order-handle"
                                    data-memo-drag-handle
                                    title="누른 채 드래그하여 메모 순서 변경"
                                    aria-label="누른 채 드래그하여 메모 순서 변경"
                                >☰</button>
                                <div class="nai-info-card-title">${escapeHtml(item.title || '메모')}</div>
                            </div>
                        </div>
                        ${selectedCategoryBadges ? `
                            <div class="nai-memo-category-badges" aria-label="선택된 메모 분류">
                                ${selectedCategoryBadges}
                            </div>
                        ` : ''}
                        <div class="nai-info-note">${escapeHtml(item.content)}</div>
                        <div class="nai-info-actions">
                            <button type="button" class="nai-loader-action danger" data-memo-action="delete">삭제</button>
                            <div class="nai-info-action-right">
                                <button type="button" class="nai-loader-action ghost" data-memo-action="share">공유</button>
                                <button type="button" class="nai-loader-action ghost" data-memo-action="edit">수정</button>
                            </div>
                        </div>
                    </article>`;
            }).join('');
        }

        function syncMemoEditDraftFromDom() {
            if (!memoEditingId || !memoEditingDraft) return;
            const card = $(`#nai-memo-list [data-memo-id="${CSS.escape(memoEditingId)}"]`);
            if (!card) return;
            memoEditingDraft = {
                ...memoEditingDraft,
                title: String(card.querySelector('[data-memo-edit-field="title"]')?.value || '').trim(),
                content: String(card.querySelector('[data-memo-edit-field="content"]')?.value || '').trim()
            };
        }

        function addMemo() {
            const status = $('#nai-memo-status');
            const title = String($('#nai-memo-title')?.value || '').trim();
            const content = String($('#nai-memo-content')?.value || '').trim();
            if (!content) {
                status.textContent = '메모 내용을 입력해주세요.';
                return;
            }
            const now = Date.now();
            const memos = getMemos();
            const categories = normalizeLibraryCategoryList([...memoCreateCategories]);
            memos.unshift({ id: createId(), title, content, categories, createdAt: now, updatedAt: now });
            saveMemos(memos);
            clearMemoCreateForm();
            setCreatePanelOpen('memos', false);
            status.textContent = title ? `"${title}" 메모를 저장했습니다.` : '메모를 저장했습니다.';
            renderMemos();
        }

        async function handleMemoAction(button) {
            const action = button.dataset.memoAction;
            if (action === 'add') {
                addMemo();
                return;
            }
            if (action === 'cancel-add') {
                clearMemoCreateForm();
                setCreatePanelOpen('memos', false);
                $('#nai-memo-status').textContent = '';
                return;
            }
            const card = button.closest('[data-memo-id]');
            const id = card?.dataset.memoId;
            if (!id) return;
            const memos = getMemos();
            const index = memos.findIndex(item => item.id === id);
            if (index < 0) return;
            const item = normalizeMemoRecord(memos[index]);
            const status = $('#nai-memo-status');

            if (action === 'share') {
                try {
                    const shareCode = createMemoShareCode(item);
                    const ok = await copyText(shareCode);
                    const label = item.title ? `"${item.title}"` : '메모';
                    status.textContent = ok
                        ? `${label} 공유 코드를 클립보드에 복사했습니다.`
                        : '메모 공유 코드 클립보드 복사에 실패했습니다.';
                } catch (error) {
                    status.textContent = `메모 공유 코드 생성 실패: ${error?.message || String(error)}`;
                }
                return;
            }
            if (action === 'edit') {
                memoEditingId = id;
                memoEditingDraft = { ...item };
                renderMemos();
                return;
            }
            if (action === 'cancel-edit') {
                memoEditingId = null;
                memoEditingDraft = null;
                renderMemos();
                return;
            }
            if (action === 'save-edit') {
                syncMemoEditDraftFromDom();
                const content = String(memoEditingDraft?.content || '').trim();
                if (!content) {
                    status.textContent = '메모 내용을 입력해주세요.';
                    return;
                }
                memos[index] = {
                    ...item,
                    ...memoEditingDraft,
                    content,
                    updatedAt: Date.now()
                };
                saveMemos(memos);
                memoEditingId = null;
                memoEditingDraft = null;
                status.textContent = '메모를 수정했습니다.';
                renderMemos();
                return;
            }
            if (action === 'delete') {
                memos.splice(index, 1);
                saveMemos(memos);
                if (memoEditingId === id) {
                    memoEditingId = null;
                    memoEditingDraft = null;
                }
                status.textContent = '메모를 삭제했습니다.';
                renderMemos();
            }
        }

        function syncManualDraftFromDom() {
            const card = $('#nai-manual-editor-root [data-manual-edit-card]');
            if (!card) return;

            const currentCharacters = Array.isArray(manualDraft.characters)
                ? manualDraft.characters
                : [];
            const characters = [...card.querySelectorAll('[data-manual-character-index]')]
                .map(characterCard => {
                    const index = Number(characterCard.dataset.manualCharacterIndex);
                    const current = currentCharacters[index] || {};
                    const prompt = String(
                        characterCard.querySelector('[data-manual-character-field="prompt"]')?.value || ''
                    ).trim();
                    const negativePrompt = String(
                        characterCard.querySelector('[data-manual-character-field="negativePrompt"]')?.value || ''
                    ).trim();

                    return {
                        name:
                            String(current.name || '').trim() ||
                            `Character ${index + 1}`,
                        prompt,
                        negativePrompt,
                        ...(!prompt && !negativePrompt ? { _analysisDraft: true } : {})
                    };
                });

            manualDraft = {
                ...manualDraft,
                name: String(card.querySelector('[data-manual-field="name"]')?.value || '').trim(),
                note: String(card.querySelector('[data-manual-field="note"]')?.value || '').trim(),
                sourceUrl: String(card.querySelector('[data-manual-field="sourceUrl"]')?.value || '').trim(),
                tags: String(card.querySelector('[data-manual-field="tags"]')?.value || '').trim(),
                negativeTags: String(card.querySelector('[data-manual-field="negativeTags"]')?.value || '').trim(),
                characters
            };
        }

        function renderManualAddEditor() {
            const root = $('#nai-manual-editor-root');
            if (!root) return;

            const characters = Array.isArray(manualDraft.characters)
                ? manualDraft.characters
                : [];
            const manualNoteOpen =
                typeof manualDraft._noteOpen === 'boolean'
                    ? manualDraft._noteOpen
                    : !!String(manualDraft.note || '').trim();

            root.innerHTML = `
                <article class="nai-concept-card" data-manual-edit-card>
                    <div class="nai-concept-card-header">
                        <div class="nai-concept-name">새 컨셉</div>
                        <button
                            type="button"
                            class="nai-inline-note-toggle"
                            data-manual-note-toggle
                            aria-expanded="${manualNoteOpen ? 'true' : 'false'}"
                        >메모 ${manualNoteOpen ? '▼' : '◀'}</button>
                    </div>

                    <div
                        class="nai-inline-note-body"
                        data-manual-note-body
                        ${manualNoteOpen ? '' : 'hidden'}
                    >
                        <textarea
                            class="nai-loader-textarea nai-note-editor"
                            data-manual-field="note"
                            placeholder="설명 / 사용 팁 / 주의사항"
                        >${escapeHtml(manualDraft.note || '')}</textarea>
                    </div>

                    <div class="nai-loader-field">
                        <label class="nai-loader-label">이름</label>
                        <input
                            class="nai-loader-input"
                            data-manual-field="name"
                            type="text"
                            value="${escapeHtml(manualDraft.name || '')}"
                            placeholder="예: 메이드복"
                        >
                    </div>

                    <div class="nai-loader-field nai-library-edit-category-field">
                        <label class="nai-loader-label">분류</label>
                        <div id="nai-manual-create-categories" class="nai-library-card-category-row" aria-label="새 컨셉 분류">
                            ${getLibraryCategories().length
                                ? renderManualCreateCategoryAssignmentHtml()
                                : '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>'}
                        </div>
                    </div>

                    <div class="nai-analysis-prompt-editor" data-manual-prompt-editor>
                        <div class="nai-analysis-prompt-tabs">
                            <button type="button" class="nai-analysis-prompt-tab active" data-analysis-prompt-tab="prompt">Base Prompt</button>
                            <button type="button" class="nai-analysis-prompt-tab" data-analysis-prompt-tab="negative">Undesired Content</button>
                        </div>
                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                            <textarea
                                class="nai-loader-textarea"
                                data-manual-field="tags"
                                placeholder="Base Prompt"
                            >${escapeHtml(manualDraft.tags || '')}</textarea>
                        </div>
                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                            <textarea
                                class="nai-loader-textarea"
                                data-manual-field="negativeTags"
                                placeholder="Undesired Content"
                            >${escapeHtml(manualDraft.negativeTags || '')}</textarea>
                        </div>
                    </div>

                    <div class="nai-ai-result-head" style="margin-top:12px; margin-bottom:8px;">
                        <div class="nai-loader-label" style="margin:0;">Character Prompts</div>
                        <div class="nai-ai-extra-options">
                            <button
                                type="button"
                                class="nai-ai-add-character"
                                data-manual-edit-action="add-character"
                            >+ 캐릭터프롬 추가</button>
                        </div>
                    </div>

                    ${characters.length ? `
                        <div class="nai-character-group">
                            ${characters.map((character, characterIndex) => `
                                <div class="nai-ai-character-block" data-manual-character-index="${characterIndex}">
                                    <div class="nai-ai-character-title-row">
                                        <div class="nai-character-title" style="margin-bottom:0;">
                                            ${escapeHtml(character.name || `Character ${characterIndex + 1}`)}
                                        </div>
                                        <button
                                            type="button"
                                            class="nai-ai-character-remove"
                                            data-manual-edit-action="remove-character"
                                            title="이 Character Prompt 삭제"
                                            aria-label="이 Character Prompt 삭제"
                                        >×</button>
                                    </div>

                                    <div class="nai-analysis-prompt-editor" data-manual-prompt-editor style="margin-bottom:0;">
                                        <div class="nai-analysis-prompt-tabs">
                                            <button type="button" class="nai-analysis-prompt-tab active" data-analysis-prompt-tab="prompt">Prompt</button>
                                            <button type="button" class="nai-analysis-prompt-tab" data-analysis-prompt-tab="negative">Undesired Content</button>
                                        </div>
                                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                                            <textarea
                                                class="nai-loader-textarea"
                                                data-manual-character-field="prompt"
                                                placeholder="Character ${characterIndex + 1} Prompt"
                                            >${escapeHtml(character.prompt || '')}</textarea>
                                        </div>
                                        <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                                            <textarea
                                                class="nai-loader-textarea"
                                                data-manual-character-field="negativePrompt"
                                                placeholder="Character ${characterIndex + 1} Undesired Content"
                                            >${escapeHtml(character.negativePrompt || '')}</textarea>
                                        </div>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    ` : ''}

                    <div class="nai-loader-field" style="margin-top:12px; margin-bottom:0;">
                        <label class="nai-loader-label">원본 링크 <span class="nai-loader-muted">(선택)</span></label>
                        <input
                            class="nai-loader-input"
                            data-manual-field="sourceUrl"
                            type="url"
                            value="${escapeHtml(manualDraft.sourceUrl || '')}"
                            placeholder="https://..."
                        >
                    </div>

                    <div class="nai-concept-footer">
                        <div class="nai-edit-footer-actions">
                            <button type="button" class="nai-loader-action" data-manual-edit-action="cancel-add">취소</button>
                            <button type="button" class="nai-loader-action primary" data-action="save-import">라이브러리에 저장</button>
                        </div>
                    </div>
                </article>
            `;

            requestAnimationFrame(() => {
                root.querySelectorAll('.nai-loader-textarea').forEach(textarea => {
                    const panel = textarea.closest('[data-analysis-prompt-panel]');
                    if (panel?.hidden) return;
                    fitAnalysisTextarea(textarea);
                });
            });
        }

        function syncLibraryEditDraftFromDom() {
            if (!editingId || !editingDraft) return;

            const card = $('#nai-library-list [data-library-edit-card]');
            if (!card) return;

            const nameField = card.querySelector('[data-edit-field="name"]');
            const noteField = card.querySelector('[data-edit-field="note"]');
            const sourceUrlField = card.querySelector('[data-edit-field="sourceUrl"]');
            const tagsField = card.querySelector('[data-edit-field="tags"]');
            const negativeField = card.querySelector('[data-edit-field="negativeTags"]');

            const currentCharacters = Array.isArray(editingDraft.characters)
                ? editingDraft.characters
                : [];

            const characters = [...card.querySelectorAll('[data-edit-character-index]')]
                .map(characterCard => {
                    const index = Number(characterCard.dataset.editCharacterIndex);
                    const current = currentCharacters[index] || {};
                    const prompt = String(
                        characterCard.querySelector('[data-edit-character-field="prompt"]')?.value || ''
                    ).trim();
                    const negativePrompt = String(
                        characterCard.querySelector('[data-edit-character-field="negativePrompt"]')?.value || ''
                    ).trim();

                    return {
                        name:
                            String(current.name || '').trim() ||
                            `Character ${index + 1}`,
                        prompt,
                        negativePrompt,
                        ...(!prompt && !negativePrompt ? { _analysisDraft: true } : {})
                    };
                });

            editingDraft = {
                ...editingDraft,
                name: String(nameField?.value || editingDraft.name || '').trim(),
                note: String(noteField?.value || '').trim(),
                source: {
                    ...(editingDraft.source || {}),
                    url: String(sourceUrlField?.value || '').trim()
                },
                tags: String(tagsField?.value || '').trim(),
                negativeTags: String(negativeField?.value || '').trim(),
                characters
            };
        }

        function cleanLibraryEditCharacters(rows) {
            return normalizeCharacterRows(
                (Array.isArray(rows) ? rows : []).map(row => ({
                    ...row,
                    _analysisDraft: false
                }))
            );
        }

        function renderLibraryCategoryBar() {
            const bar = $('#nai-library-category-bar');
            if (!bar) return;

            const categories = getLibraryCategories();
            const valid = new Set(categories);
            [...activeLibraryCategories].forEach(name => {
                if (!valid.has(name)) activeLibraryCategories.delete(name);
            });

            const filters = [
                `<button type="button" class="nai-library-category-chip${activeLibraryCategories.size ? '' : ' active'}" data-library-category-filter="__all__">전체</button>`
            ];

            categories.forEach(name => {
                filters.push(
                    `<button type="button" class="nai-library-category-chip${activeLibraryCategories.has(name) ? ' active' : ''}" data-library-category-filter="${escapeHtml(name)}">${escapeHtml(name)}</button>`
                );
            });

            const manager = libraryCategoryEditMode ? `
                <div class="nai-library-category-manager" data-library-category-manager>
                    ${categories.length ? categories.map((name, index) => `
                        <div class="nai-library-category-manager-row" data-library-category-manager-row="${escapeHtml(name)}">
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-library-category-move="up"
                                data-library-category-name="${escapeHtml(name)}"
                                title="위로 이동"
                                ${index === 0 ? 'disabled' : ''}
                            >↑</button>
                            <button
                                type="button"
                                class="nai-library-category-manager-button"
                                data-library-category-move="down"
                                data-library-category-name="${escapeHtml(name)}"
                                title="아래로 이동"
                                ${index === categories.length - 1 ? 'disabled' : ''}
                            >↓</button>
                            <input
                                type="text"
                                class="nai-loader-input nai-loader-grow"
                                value="${escapeHtml(name)}"
                                data-library-category-rename="${escapeHtml(name)}"
                                aria-label="${escapeHtml(name)} 분류 이름"
                            >
                            <button
                                type="button"
                                class="nai-library-category-manager-button danger"
                                data-library-category-delete="${escapeHtml(name)}"
                            >삭제</button>
                        </div>
                    `).join('') : '<div class="nai-library-category-empty">아직 만든 분류가 없습니다.</div>'}
                </div>
            ` : '';

            bar.innerHTML = `
                <div class="nai-library-category-filter-group">
                    ${filters.join('')}
                </div>
                <div class="nai-library-category-tools">
                    <button
                        type="button"
                        class="nai-library-category-chip nai-library-category-edit-button${libraryCategoryEditMode ? ' active' : ''}"
                        data-library-category-edit-toggle
                        aria-expanded="${libraryCategoryEditMode ? 'true' : 'false'}"
                    >${libraryCategoryEditMode ? '완료' : '수정'}</button>
                    <button
                        type="button"
                        class="nai-library-category-chip nai-category-add"
                        data-library-category-add
                        title="새 분류 추가"
                        aria-label="새 분류 추가"
                    >+</button>
                </div>
                ${manager}
            `;
        }

        function renderLibraryCategoryAssignment(item) {
            const categories = getLibraryCategories();
            if (!categories.length) return '';

            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-library-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderAnalysisCategoryAssignment(item) {
            const categories = getLibraryCategories();
            if (!categories.length) {
                return '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
            }

            const selected = new Set(normalizeLibraryCategoryList(item?.categories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-result-category-assign="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renameLibraryCategory(oldName, rawNewName) {
            const previous = normalizeLibraryCategoryName(oldName);
            const next = normalizeLibraryCategoryName(rawNewName);
            if (!previous) return false;

            if (!next || next === '전체' || next === '+') {
                $('#nai-library-status').textContent = '이 이름은 분류로 사용할 수 없습니다.';
                renderLibrary();
                return false;
            }
            if (previous === next) return true;

            const categories = getLibraryCategories();
            if (categories.includes(next)) {
                $('#nai-library-status').textContent = `"${next}" 분류는 이미 있습니다.`;
                renderLibrary();
                return false;
            }

            const categoryIndex = categories.indexOf(previous);
            if (categoryIndex < 0) return false;
            categories[categoryIndex] = next;
            saveLibraryCategories(categories);

            const library = getLibrary().map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).map(name => name === previous ? next : name)
                    )
                };
            });
            saveLibrary(library);

            if (activeLibraryCategories.delete(previous)) {
                activeLibraryCategories.add(next);
            }
            if (editingDraft?.categories) {
                editingDraft.categories = normalizeLibraryCategoryList(
                    editingDraft.categories.map(name => name === previous ? next : name)
                );
            }

            $('#nai-library-status').textContent = `"${previous}" → "${next}"로 변경했습니다.`;
            renderLibrary();
            return true;
        }

        function deleteLibraryCategory(name) {
            const target = normalizeLibraryCategoryName(name);
            if (!target) return;
            if (!window.confirm(`"${target}" 분류를 삭제할까요?\n카드에 지정된 이 분류도 함께 제거됩니다.`)) return;

            saveLibraryCategories(
                getLibraryCategories().filter(category => category !== target)
            );

            const library = getLibrary().map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                return {
                    ...item,
                    categories: normalizeLibraryCategoryList(
                        (item.categories || []).filter(category => category !== target)
                    )
                };
            });
            saveLibrary(library);

            activeLibraryCategories.delete(target);
            if (editingDraft?.categories) {
                editingDraft.categories = normalizeLibraryCategoryList(
                    editingDraft.categories.filter(category => category !== target)
                );
            }

            $('#nai-library-status').textContent = `"${target}" 분류를 삭제했습니다.`;
            renderLibrary();
        }

        function moveLibraryCategory(name, direction) {
            const target = normalizeLibraryCategoryName(name);
            const categories = getLibraryCategories();
            const index = categories.indexOf(target);
            if (index < 0) return;

            const nextIndex = direction === 'up' ? index - 1 : index + 1;
            if (nextIndex < 0 || nextIndex >= categories.length) return;

            [categories[index], categories[nextIndex]] = [categories[nextIndex], categories[index]];
            saveLibraryCategories(categories);
            renderLibrary();
        }

        function saveVisibleLibraryOrder(orderedVisibleIds) {
            const library = getLibrary();
            if (!library.length) return false;

            const byId = new Map(library.map(item => [item.id, item]));
            const visibleSet = new Set(
                visibleLibraryIds.filter(id => byId.has(id))
            );
            if (visibleSet.size < 2) return false;

            const nextVisibleOrder = [];
            orderedVisibleIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });
            visibleLibraryIds.forEach(id => {
                if (visibleSet.has(id) && !nextVisibleOrder.includes(id)) {
                    nextVisibleOrder.push(id);
                }
            });

            let cursor = 0;
            const reordered = library.map(item => {
                if (!visibleSet.has(item.id)) return item;
                const nextId = nextVisibleOrder[cursor++];
                return byId.get(nextId) || item;
            });

            saveLibrary(reordered);
            return true;
        }

        function renderLibrary() {
            if (naiNotionController?.shouldHandleLibraryRender?.()) {
                naiNotionController.renderLibraryPanel();
                return;
            }
            renderLibraryCategoryBar();
            if (libraryCreateOpen) renderManualCreateCategoryAssignment();

            const query =
                ($('#nai-library-search').value || '')
                    .trim()
                    .toLowerCase();

            const library = getLibrary();

            const filtered = library.filter(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const itemCategories = new Set(item.categories || []);

                const categoryMatches = [...activeLibraryCategories]
                    .every(name => itemCategories.has(name));
                if (!categoryMatches) return false;

                if (!query) return true;

                const characterText = (item.characters || [])
                    .flatMap(character => [
                        character.name,
                        character.prompt,
                        character.negativePrompt
                    ]);

                return [
                    item.name,
                    item.tags,
                    item.negativeTags,
                    item.note,
                    ...characterText,
                    item?.source?.url,
                    item?.source?.type
                ]
                    .filter(Boolean)
                    .some(value =>
                        String(value).toLowerCase().includes(query)
                    );
            });

            const list = $('#nai-library-list');
            visibleLibraryIds = filtered.map(rawItem => normalizeConceptRecord(rawItem).id);

            if (!filtered.length) {
                visibleLibraryIds = [];
                list.innerHTML = `
                    <div class="nai-library-empty">
                        ${
                            library.length
                                ? '검색 결과가 없습니다.'
                                : '아직 저장한 컨셉이 없습니다.<br>가져오기 탭에서 첫 컨셉을 저장해보세요.'
                        }
                    </div>
                `;
                return;
            }

            list.innerHTML = filtered.map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const sourceUrl = item?.source?.url || '';
                const isEditing = editingId === item.id;

                if (isEditing) {
                    if (!editingDraft || editingDraft.id !== item.id) {
                        editingDraft = {
                            ...item,
                            characters: (item.characters || []).map(character => ({ ...character }))
                        };
                    }

                    const draft = editingDraft;
                    const characters = Array.isArray(draft.characters)
                        ? draft.characters
                        : [];
                    const editNoteOpen =
                        typeof draft._noteOpen === 'boolean'
                            ? draft._noteOpen
                            : !!String(draft.note || '').trim();

                    return `
                        <article
                            class="nai-concept-card"
                            data-concept-id="${escapeHtml(item.id)}"
                            data-library-edit-card
                        >
                            <div class="nai-concept-card-header">
                                <div class="nai-concept-name">${escapeHtml(item.name)} · 수정</div>
                                <button
                                    type="button"
                                    class="nai-inline-note-toggle"
                                    data-library-edit-note-toggle
                                    aria-expanded="${editNoteOpen ? 'true' : 'false'}"
                                >메모 ${editNoteOpen ? '▼' : '◀'}</button>
                            </div>

                            <div
                                class="nai-inline-note-body"
                                data-library-edit-note-body
                                ${editNoteOpen ? '' : 'hidden'}
                            >
                                <textarea
                                    class="nai-loader-textarea nai-note-editor"
                                    data-edit-field="note"
                                    placeholder="설명 / 사용 팁 / 주의사항"
                                >${escapeHtml(draft.note || '')}</textarea>
                            </div>

                            <div class="nai-loader-field">
                                <label class="nai-loader-label">이름</label>
                                <input
                                    class="nai-loader-input"
                                    data-edit-field="name"
                                    type="text"
                                    value="${escapeHtml(draft.name ?? item.name)}"
                                >
                            </div>

                            ${getLibraryCategories().length ? `
                                <div class="nai-loader-field nai-library-edit-category-field">
                                    <label class="nai-loader-label">분류</label>
                                    <div class="nai-library-card-category-row" aria-label="컨셉 분류">
                                        ${renderLibraryCategoryAssignment(draft)}
                                    </div>
                                </div>
                            ` : ''}

                            <div
                                class="nai-analysis-prompt-editor"
                                data-library-prompt-editor
                            >
                                <div class="nai-analysis-prompt-tabs">
                                    <button
                                        type="button"
                                        class="nai-analysis-prompt-tab active"
                                        data-analysis-prompt-tab="prompt"
                                    >Base Prompt</button>
                                    <button
                                        type="button"
                                        class="nai-analysis-prompt-tab"
                                        data-analysis-prompt-tab="negative"
                                    >Undesired Content</button>
                                </div>

                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                                    <textarea
                                        class="nai-loader-textarea"
                                        data-edit-field="tags"
                                        placeholder="Base Prompt"
                                    >${escapeHtml(draft.tags || '')}</textarea>
                                </div>

                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                                    <textarea
                                        class="nai-loader-textarea"
                                        data-edit-field="negativeTags"
                                        placeholder="Negative Prompt / Undesired Content"
                                    >${escapeHtml(draft.negativeTags || '')}</textarea>
                                </div>
                            </div>

                            <div class="nai-ai-result-head" style="margin-top:12px; margin-bottom:8px;">
                                <div class="nai-loader-label" style="margin:0;">Character Prompts</div>
                                <div class="nai-ai-extra-options">
                                    <button
                                        type="button"
                                        class="nai-ai-add-character"
                                        data-library-edit-action="add-character"
                                            >+ 캐릭터프롬 추가</button>
                                </div>
                            </div>

                            ${characters.length ? `
                                <div class="nai-character-group">
                                    ${characters.map((character, characterIndex) => `
                                        <div
                                            class="nai-ai-character-block"
                                            data-edit-character-index="${characterIndex}"
                                        >
                                            <div class="nai-ai-character-title-row">
                                                <div class="nai-character-title" style="margin-bottom:0;">
                                                    ${escapeHtml(character.name || `Character ${characterIndex + 1}`)}
                                                </div>
                                                <button
                                                    type="button"
                                                    class="nai-ai-character-remove"
                                                    data-library-edit-action="remove-character"
                                                    title="이 Character Prompt 삭제"
                                                    aria-label="이 Character Prompt 삭제"
                                                >×</button>
                                            </div>

                                            <div class="nai-analysis-prompt-editor" data-library-prompt-editor style="margin-bottom:0;">
                                                <div class="nai-analysis-prompt-tabs">
                                                    <button
                                                        type="button"
                                                        class="nai-analysis-prompt-tab active"
                                                        data-analysis-prompt-tab="prompt"
                                                    >Prompt</button>
                                                    <button
                                                        type="button"
                                                        class="nai-analysis-prompt-tab"
                                                        data-analysis-prompt-tab="negative"
                                                    >Undesired Content</button>
                                                </div>

                                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="prompt">
                                                    <textarea
                                                        class="nai-loader-textarea"
                                                        data-edit-character-field="prompt"
                                                        placeholder="Character ${characterIndex + 1} Prompt"
                                                    >${escapeHtml(character.prompt || '')}</textarea>
                                                </div>

                                                <div class="nai-analysis-prompt-panel" data-analysis-prompt-panel="negative" hidden>
                                                    <textarea
                                                        class="nai-loader-textarea"
                                                        data-edit-character-field="negativePrompt"
                                                        placeholder="Character ${characterIndex + 1} Undesired Content"
                                                    >${escapeHtml(character.negativePrompt || '')}</textarea>
                                                </div>
                                            </div>
                                        </div>
                                    `).join('')}
                                </div>
                            ` : ''}

                            <div class="nai-loader-field" style="margin-top:12px; margin-bottom:0;">
                                <label class="nai-loader-label">원본 링크 <span class="nai-loader-muted">(선택)</span></label>
                                <input
                                    class="nai-loader-input"
                                    data-edit-field="sourceUrl"
                                    type="url"
                                    value="${escapeHtml(draft?.source?.url || '')}"
                                    placeholder="https://..."
                                >
                            </div>

                            <div class="nai-concept-footer">
                                <div class="nai-edit-footer-actions">
                                    <button
                                        type="button"
                                        class="nai-loader-action"
                                        data-concept-action="cancel-edit"
                                    >취소</button>
                                    <button
                                        type="button"
                                        class="nai-loader-action primary"
                                        data-concept-action="save-edit"
                                    >수정 저장</button>
                                </div>
                            </div>
                        </article>
                    `;
                }

                const characters = item.characters || [];
                const cardOpen = expandedLibraryCards.has(item.id);
                const noteOpen = expandedLibraryNotes.has(item.id);

                return `
                    <article
                        class="nai-concept-card${cardOpen ? '' : ' nai-library-card-collapsed'}"
                        data-concept-id="${escapeHtml(item.id)}"
                    >
                        <div
                            class="nai-library-card-summary"
                            data-library-card-toggle
                            aria-expanded="${cardOpen ? 'true' : 'false'}"
                            title="컨셉 내용 ${cardOpen ? '접기' : '펼치기'}"
                        >
                            <div class="nai-library-card-summary-main">
                                <div class="nai-library-card-toggle">
                                    <button
                                        type="button"
                                        class="nai-library-order-handle"
                                        data-library-drag-handle
                                        title="누른 채 드래그하여 카드 순서 변경"
                                        aria-label="누른 채 드래그하여 카드 순서 변경"
                                    >☰</button>
                                    <span class="nai-concept-name" data-library-title-marquee><span class="nai-library-title-marquee-text">${escapeHtml(item.name)}</span></span>
                                    <span class="nai-card-note-separator" data-library-note-separator ${item.note ? '' : 'hidden'}>·</span>
                                    <span class="nai-card-note-preview" data-library-note-preview ${item.note ? '' : 'hidden'}>${escapeHtml(item.note || '')}</span>
                                </div>
                            </div>
                            <div class="nai-library-summary-actions">
                                <button type="button" class="nai-loader-action" data-concept-action="edit">수정</button>
                                <button type="button" class="nai-loader-action primary" data-concept-action="use">사용</button>
                            </div>
                        </div>

                        <div class="nai-library-card-body" data-library-card-body ${cardOpen ? '' : 'hidden'}>
                            <div class="nai-library-card-category-row" aria-label="컨셉 분류">
                                ${renderLibraryCategoryAssignment(item)}
                            </div>

                            ${item.tags ? `
                                <div class="nai-loader-label" style="margin-top:2px;">Base Prompt</div>
                                <div class="nai-concept-tags">${escapeHtml(item.tags)}</div>
                            ` : ''}

                            ${item.negativeTags ? `
                                <div class="nai-loader-label" style="margin-top:10px;">Undesired Content</div>
                                <div class="nai-concept-tags">${escapeHtml(item.negativeTags)}</div>
                            ` : ''}

                            ${characters.length ? `
                                <div class="nai-loader-label" style="margin-top:12px;">Character Prompts</div>
                                <div class="nai-character-group">
                                    ${characters.map((character, characterIndex) => `
                                        <div class="nai-character-block">
                                            <div class="nai-character-title">
                                                ${escapeHtml(character.name || `Character ${characterIndex + 1}`)}
                                            </div>
                                            ${character.prompt ? `
                                                <div class="nai-character-subtitle">Prompt</div>
                                                <div class="nai-concept-tags">${escapeHtml(character.prompt)}</div>
                                            ` : ''}
                                            ${character.negativePrompt ? `
                                                <div class="nai-character-subtitle">Undesired Content</div>
                                                <div class="nai-concept-tags">${escapeHtml(character.negativePrompt)}</div>
                                            ` : ''}
                                        </div>
                                    `).join('')}
                                </div>
                            ` : ''}

                            <div class="nai-concept-footer">
                                <div class="nai-concept-actions">
                                    <button type="button" class="nai-loader-action danger" data-concept-action="delete">삭제</button>
                                    <div class="nai-concept-action-right">
                                        <button type="button" class="nai-loader-action" data-concept-action="share">공유</button>
                                        ${sourceUrl ? `<button type="button" class="nai-loader-action ghost" data-concept-action="source">원본</button>` : ''}
                                        <button
                                            type="button"
                                            class="nai-loader-action${noteOpen ? ' nai-library-note-active' : ''}"
                                            data-library-note-toggle
                                            aria-expanded="${noteOpen ? 'true' : 'false'}"
                                        >메모</button>
                                        <button type="button" class="nai-loader-action" data-concept-action="edit">수정</button>
                                        ${item.negativeTags ? `<button type="button" class="nai-loader-action" data-concept-action="copy-negative">네거 복사</button>` : ''}
                                        ${item.tags ? `<button type="button" class="nai-loader-action" data-concept-action="copy">복사</button>` : ''}
                                        <button type="button" class="nai-loader-action primary" data-concept-action="use">사용</button>
                                    </div>
                                </div>
                            </div>

                            <div class="nai-library-note-body" data-library-note-body ${noteOpen ? '' : 'hidden'}>
                                <textarea
                                    class="nai-loader-textarea nai-note-editor"
                                    data-library-note
                                    placeholder="설명 / 사용 팁 / 주의사항"
                                >${escapeHtml(item.note || '')}</textarea>
                            </div>
                        </div>
                    </article>
                `;
            }).join('');

            requestAnimationFrame(() => {
                updateLibraryTitleMarquees(list);

                list.querySelectorAll('[data-library-edit-card] .nai-loader-textarea').forEach(textarea => {
                    const panel = textarea.closest('[data-analysis-prompt-panel]');
                    if (panel?.hidden) return;
                    fitAnalysisTextarea(textarea);
                });

                list.querySelectorAll('[data-library-note-body]:not([hidden]) [data-library-note]').forEach(textarea => {
                    fitAnalysisTextarea(textarea);
                });
            });
        }

        function updateLibraryTitleMarquees(root = document) {
            root.querySelectorAll?.('[data-library-title-marquee]').forEach(viewport => {
                const text = viewport.querySelector('.nai-library-title-marquee-text');
                if (!text) return;

                viewport.classList.remove('nai-title-overflowing');
                viewport.style.removeProperty('--nai-library-title-shift');
                text.style.transform = '';

                const overflow = Math.ceil(text.scrollWidth - viewport.clientWidth);
                if (overflow > 4) {
                    viewport.style.setProperty('--nai-library-title-shift', `${-(overflow + 4)}px`);
                    viewport.classList.add('nai-title-overflowing');
                }
            });
        }

        function fitAnalysisTextarea(textarea) {
            if (!textarea || textarea.hidden) return;
            textarea.style.height = 'auto';
            const next = Math.min(
                260,
                Math.max(56, textarea.scrollHeight + 2)
            );
            textarea.style.height = `${next}px`;
        }

        function activateAnalysisPromptTab(editor, tabName) {
            if (!editor) return;
            const nextTab = tabName === 'negative' ? 'negative' : 'prompt';

            editor.querySelectorAll('[data-analysis-prompt-tab]').forEach(button => {
                button.classList.toggle(
                    'active',
                    button.dataset.analysisPromptTab === nextTab
                );
            });

            editor.querySelectorAll('[data-analysis-prompt-panel]').forEach(panel => {
                panel.hidden = panel.dataset.analysisPromptPanel !== nextTab;
            });

            requestAnimationFrame(() => {
                editor.querySelectorAll(
                    '[data-analysis-prompt-panel]:not([hidden]) .nai-loader-textarea'
                ).forEach(fitAnalysisTextarea);
            });
        }

        function nextAnalysisCharacterName(characters) {
            return `Character ${characters.length + 1}`;
        }

        function renumberAnalysisCharacters(characters) {
            return normalizeCharacterRows(characters).map((character, index) => ({
                ...character,
                name: /^Character\s+\d+$/i.test(String(character.name || '').trim())
                    ? `Character ${index + 1}`
                    : character.name
            }));
        }


        function renderAnalysisResults() {
            const wrap = $('#nai-analysis-wrap');
            const list = $('#nai-ai-results');

            if (!wrap || !list) return;

            if (!analysisResults.length) {
                wrap.style.display = 'none';
                list.innerHTML = '';
                return;
            }

            wrap.style.display = 'block';

            const methodLabel =
                analysisMeta?.method === 'share-code'
                    ? '공유 코드'
                    : analysisMeta?.method === 'direct-fetch'
                        ? '직접 원문 fallback'
                        : analysisMeta?.method === 'notion-browser-crawl'
                            ? `Notion 실제 화면 ${analysisMeta?.pagesVisited || 0}페이지`
                            : analysisMeta?.method === 'notion-tree'
                                ? `Notion 트리 ${analysisMeta?.pagesVisited || 0}페이지${
                                    analysisMeta?.assetsVisited
                                        ? ` + 첨부 ${analysisMeta.assetsVisited}`
                                        : ''
                                }`
                                : 'URL Context';

            $('#nai-analysis-meta').textContent =
                `${analysisMeta?.pageTitle || '제목 없음'} · ${methodLabel} · ${analysisResults.length}개 세트 발견`;

            list.innerHTML = analysisResults.map((rawItem, index) => {
                const item = normalizeConceptRecord(rawItem);
                const characters = item.characters || [];
                const duplicateItem = findLibraryExactDuplicate(item);
                const resultNoteOpen =
                    typeof item._noteOpen === 'boolean'
                        ? item._noteOpen
                        : !!String(item.note || '').trim();

                return `
                    <article
                        class="nai-ai-result-card"
                        data-result-id="${escapeHtml(item.id)}"
                    >
                        <div class="nai-ai-result-head">
                            <input
                                type="checkbox"
                                data-result-field="selected"
                                ${item.selected ? 'checked' : ''}
                            >

                            <div class="nai-ai-result-index">
                                #${index + 1}
                            </div>

                            <span
                                class="nai-duplicate-badge"
                                data-result-duplicate-badge
                                title="이미 라이브러리에 Prompt 내용이 완전히 같은 컨셉이 있습니다."
                                ${duplicateItem ? '' : 'hidden'}
                            >중복</span>

                            <div class="nai-ai-extra-options">
                                <button
                                    type="button"
                                    class="nai-inline-note-toggle"
                                    data-result-note-toggle
                                    aria-expanded="${resultNoteOpen ? 'true' : 'false'}"
                                >메모 ${resultNoteOpen ? '▼' : '◀'}</button>
                                <button
                                    type="button"
                                    class="nai-ai-add-character"
                                    data-result-action="add-character"
                                    >+ 캐릭터프롬 추가</button>
                            </div>
                        </div>

                        <div
                            class="nai-inline-note-body"
                            data-result-note-body
                            ${resultNoteOpen ? '' : 'hidden'}
                        >
                            <textarea
                                class="nai-loader-textarea nai-note-editor"
                                data-result-field="note"
                                placeholder="설명 / 사용 팁 / 주의사항"
                            >${escapeHtml(item.note || '')}</textarea>
                        </div>

                        <div class="nai-loader-field">
                            <label class="nai-loader-label">
                                저장할 이름
                            </label>

                            <input
                                class="nai-loader-input"
                                type="text"
                                data-result-field="name"
                                value="${escapeHtml(item.suggestedName)}"
                            >
                        </div>

                        <div class="nai-loader-field nai-library-edit-category-field">
                            <label class="nai-loader-label">분류</label>
                            <div class="nai-library-card-category-row" aria-label="가져올 컨셉 분류">
                                ${renderAnalysisCategoryAssignment(item)}
                            </div>
                        </div>

                        <div
                            class="nai-analysis-prompt-editor"
                            data-result-prompt-editor
                        >
                            <div class="nai-analysis-prompt-tabs">
                                <button
                                    type="button"
                                    class="nai-analysis-prompt-tab active"
                                    data-analysis-prompt-tab="prompt"
                                >Base Prompt</button>
                                <button
                                    type="button"
                                    class="nai-analysis-prompt-tab"
                                    data-analysis-prompt-tab="negative"
                                >Undesired Content</button>
                            </div>

                            <div
                                class="nai-analysis-prompt-panel"
                                data-analysis-prompt-panel="prompt"
                            >
                                <textarea
                                    class="nai-loader-textarea"
                                    data-result-field="tags"
                                    placeholder="Base Prompt"
                                >${escapeHtml(item.tags || '')}</textarea>
                            </div>

                            <div
                                class="nai-analysis-prompt-panel"
                                data-analysis-prompt-panel="negative"
                                hidden
                            >
                                <textarea
                                    class="nai-loader-textarea"
                                    data-result-field="negativeTags"
                                    placeholder="Negative Prompt / Undesired Content"
                                >${escapeHtml(item.negativeTags || '')}</textarea>
                            </div>
                        </div>

                        ${characters.length ? `
                            <div class="nai-loader-label" style="margin-bottom:8px;">
                                Character Prompts
                            </div>

                            <div class="nai-character-group">
                                ${characters.map((character, characterIndex) => `
                                    <div
                                        class="nai-ai-character-block"
                                        data-result-character-index="${characterIndex}"
                                    >
                                        <div class="nai-ai-character-title-row">
                                            <div class="nai-character-title" style="margin-bottom:0;">
                                                ${escapeHtml(
                                                    character.name ||
                                                    `Character ${characterIndex + 1}`
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                class="nai-ai-character-remove"
                                                data-result-action="remove-character"
                                                title="이 Character Prompt 삭제"
                                                aria-label="이 Character Prompt 삭제"
                                            >×</button>
                                        </div>

                                        <div
                                            class="nai-analysis-prompt-editor"
                                            data-result-prompt-editor
                                            style="margin-bottom:0;"
                                        >
                                            <div class="nai-analysis-prompt-tabs">
                                                <button
                                                    type="button"
                                                    class="nai-analysis-prompt-tab active"
                                                    data-analysis-prompt-tab="prompt"
                                                >Prompt</button>
                                                <button
                                                    type="button"
                                                    class="nai-analysis-prompt-tab"
                                                    data-analysis-prompt-tab="negative"
                                                >Undesired Content</button>
                                            </div>

                                            <div
                                                class="nai-analysis-prompt-panel"
                                                data-analysis-prompt-panel="prompt"
                                            >
                                                <textarea
                                                    class="nai-loader-textarea"
                                                    data-result-character-field="prompt"
                                                    placeholder="Character ${characterIndex + 1} Prompt"
                                                >${escapeHtml(character.prompt || '')}</textarea>
                                            </div>

                                            <div
                                                class="nai-analysis-prompt-panel"
                                                data-analysis-prompt-panel="negative"
                                                hidden
                                            >
                                                <textarea
                                                    class="nai-loader-textarea"
                                                    data-result-character-field="negativePrompt"
                                                    placeholder="Character ${characterIndex + 1} Undesired Content"
                                                >${escapeHtml(character.negativePrompt || '')}</textarea>
                                            </div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        ` : ''}

                    </article>
                `;
            }).join('');

            requestAnimationFrame(() => {
                $$('#nai-ai-results .nai-loader-textarea').forEach(textarea => {
                    const panel = textarea.closest('[data-analysis-prompt-panel]');
                    if (panel?.hidden) return;
                    fitAnalysisTextarea(textarea);
                });
            });
        }

        function syncAnalysisResultsFromDom() {
            $$('#nai-ai-results [data-result-id]').forEach(card => {
                const id = card.dataset.resultId;
                const item = analysisResults.find(row => row.id === id);

                if (!item) return;

                item.selected =
                    !!card.querySelector('[data-result-field="selected"]')?.checked;

                item.suggestedName =
                    card.querySelector('[data-result-field="name"]')?.value.trim() ||
                    item.suggestedName;

                const baseField = card.querySelector(
                    '[data-result-field="tags"]'
                );

                const negativeField = card.querySelector(
                    '[data-result-field="negativeTags"]'
                );

                if (baseField) {
                    item.tags = baseField.value.trim();
                }

                if (negativeField) {
                    item.negativeTags = negativeField.value.trim();
                }

                const noteField = card.querySelector(
                    '[data-result-field="note"]'
                );
                if (noteField) {
                    item.note = noteField.value.trim();
                }

                item.categories = normalizeLibraryCategoryList(item.categories);

                const previousCharacters = normalizeCharacterRows(item.characters);
                const nextCharacters = [];

                card.querySelectorAll(
                    '[data-result-character-index]'
                ).forEach(characterCard => {
                    const characterIndex = Number(
                        characterCard.dataset.resultCharacterIndex
                    );
                    const previous = previousCharacters[characterIndex] || {};
                    const prompt = String(
                        characterCard.querySelector(
                            '[data-result-character-field="prompt"]'
                        )?.value || ''
                    ).trim();
                    const negativePrompt = String(
                        characterCard.querySelector(
                            '[data-result-character-field="negativePrompt"]'
                        )?.value || ''
                    ).trim();

                    nextCharacters.push({
                        name:
                            String(previous.name || '').trim() ||
                            `Character ${characterIndex + 1}`,
                        prompt,
                        negativePrompt,
                        ...(!prompt && !negativePrompt
                            ? { _analysisDraft: true }
                            : {})
                    });
                });

                item.characters = normalizeCharacterRows(nextCharacters);
            });
        }

        function refreshAnalysisDuplicateBadges() {
            $$('#nai-ai-results [data-result-id]').forEach(card => {
                const item = analysisResults.find(row => row.id === card.dataset.resultId);
                const badge = card.querySelector('[data-result-duplicate-badge]');
                if (!item || !badge) return;
                badge.hidden = !findLibraryExactDuplicate(item);
            });
        }

        async function handleConceptAction(button) {
            const card = button.closest('[data-concept-id]');

            if (!card) return;

            const id = card.dataset.conceptId;
            const action = button.dataset.conceptAction;
            const library = getLibrary();
            const index = library.findIndex(item => item.id === id);

            if (index < 0) return;

            const item = normalizeConceptRecord(library[index]);
            const status = $('#nai-library-status');


            if (action === 'use') {
                const result = await insertConceptIntoNovelAI(item);

                status.textContent = result.ok
                    ? `"${item.name}" 적용 완료` +
                      `${result.insertedPositive ? ' · Base Prompt' : ''}` +
                      `${result.insertedNegative ? ' · Main UC' : ''}` +
                      `${result.insertedCharacters ? ` · Character Prompt ${result.insertedCharacters}개` : ''}` +
                      `${result.insertedCharacterNegatives ? ` · Character UC ${result.insertedCharacterNegatives}개` : ''}`
                    : result.error;

                return;
            }

            if (action === 'copy') {
                const ok = await copyText(item.tags || '');

                status.textContent = ok
                    ? `"${item.name}" Base Prompt를 클립보드에 복사했습니다.`
                    : '클립보드 복사에 실패했습니다.';

                return;
            }

            if (action === 'copy-negative') {
                const ok = await copyText(item.negativeTags || '');

                status.textContent = ok
                    ? `"${item.name}" Undesired Content를 클립보드에 복사했습니다.`
                    : '클립보드 복사에 실패했습니다.';

                return;
            }

            if (action === 'share') {
                try {
                    const shareCode = createConceptShareCode(item);
                    const ok = await copyText(shareCode);
                    status.textContent = ok
                        ? `"${item.name}" 공유 코드를 클립보드에 복사했습니다.`
                        : '공유 코드 클립보드 복사에 실패했습니다.';
                } catch (error) {
                    status.textContent = `공유 코드 생성 실패: ${error?.message || String(error)}`;
                }
                return;
            }

            if (action === 'source') {
                if (item?.source?.url) {
                    window.open(
                        item.source.url,
                        '_blank',
                        'noopener,noreferrer'
                    );
                }

                return;
            }

            if (action === 'edit') {
                editingId = id;
                editingDraft = {
                    ...item,
                    characters: (item.characters || []).map(character => ({ ...character }))
                };
                renderLibrary();

                requestAnimationFrame(() => {
                    $('#nai-library-list [data-library-edit-card] [data-edit-field="name"]')?.focus();
                });
                return;
            }

            if (action === 'cancel-edit') {
                editingId = null;
                editingDraft = null;
                renderLibrary();
                return;
            }

            if (action === 'save-edit') {
                syncLibraryEditDraftFromDom();
                const draft = editingDraft || item;
                const nextName = String(draft.name || '').trim();
                const nextTags = String(draft.tags || '').trim();
                const nextNegativeTags = String(draft.negativeTags || '').trim();
                const nextNote = String(draft.note || '').trim();
                const sourceUrlRaw = String(draft?.source?.url || '').trim();
                const nextSourceUrl = normalizedExternalUrl(sourceUrlRaw);
                const cleanedCharacters = cleanLibraryEditCharacters(draft.characters);

                if (!nextName) {
                    status.textContent = '컨셉 이름을 입력해주세요.';
                    return;
                }

                if (!nextTags && !nextNegativeTags && !cleanedCharacters.length) {
                    status.textContent =
                        'Base / UC / Character Prompt 중 하나는 있어야 합니다.';
                    return;
                }

                if (sourceUrlRaw && !nextSourceUrl) {
                    status.textContent = '원본 링크는 http:// 또는 https:// 주소로 입력해주세요.';
                    return;
                }

                library[index] = {
                    ...item,
                    name: nextName,
                    tags: nextTags,
                    negativeTags: nextNegativeTags,
                    characters: cleanedCharacters,
                    note: nextNote,
                    source: {
                        ...(item.source || {}),
                        type: nextSourceUrl ? detectSourceType(nextSourceUrl) : 'Manual',
                        url: nextSourceUrl
                    },
                    updatedAt: Date.now()
                };

                saveLibrary(library);
                editingId = null;
                editingDraft = null;
                renderLibrary();
                status.textContent = `"${nextName}" 수정 완료.`;
                return;
            }

            if (action === 'delete') {
                const confirmed =
                    window.confirm(`"${item.name}" 컨셉을 삭제할까요?`);

                if (!confirmed) return;

                library.splice(index, 1);
                saveLibrary(library);

                if (editingId === id) {
                    editingId = null;
                }

                renderLibrary();

                status.textContent = `"${item.name}" 삭제 완료.`;
            }
        }

        function saveImportedConcept() {
            syncManualDraftFromDom();

            const name = String(manualDraft.name || '').trim();
            const tags = String(manualDraft.tags || '').trim();
            const negativeTags = String(manualDraft.negativeTags || '').trim();
            const note = String(manualDraft.note || '').trim();
            const sourceUrlRaw = String(manualDraft.sourceUrl || '').trim();
            const sourceUrl = normalizedExternalUrl(sourceUrlRaw);
            const characters = cleanLibraryEditCharacters(manualDraft.characters);
            const status = $('#nai-manual-status');

            if (!name) {
                status.textContent = '저장할 컨셉 이름을 입력해주세요.';
                return;
            }

            if (!tags && !negativeTags && !characters.length) {
                status.textContent =
                    'Base / UC / Character Prompt 중 하나는 있어야 합니다.';
                return;
            }

            if (sourceUrlRaw && !sourceUrl) {
                status.textContent = '원본 링크는 http:// 또는 https:// 주소로 입력해주세요.';
                return;
            }

            const library = getLibrary();
            const now = Date.now();

            library.unshift({
                id: createId(),
                name,
                tags,
                negativeTags,
                characters,
                note,
                categories: normalizeLibraryCategoryList(manualDraft.categories),
                source: {
                    type: sourceUrl ? detectSourceType(sourceUrl) : 'Manual',
                    url: sourceUrl
                },
                createdAt: now,
                updatedAt: now
            });

            saveLibrary(library);

            manualDraft = {
                name: '',
                note: '',
                sourceUrl: '',
                tags: '',
                negativeTags: '',
                characters: [],
                categories: []
            };
            $('#nai-manual-editor-root').innerHTML = '';
            setCreatePanelOpen('library', false);

            status.textContent = '';
            $('#nai-library-status').textContent =
                `"${name}" 컨셉을 라이브러리에 저장했습니다.`;

            renderLibrary();
        }

        function syncShareImportDraftFromDom() {
            if (!shareImportDraft) return;
            const preview = $('#nai-share-import-preview');
            if (!preview) return;

            if (shareImportDraft.kind === 'resource') {
                shareImportDraft = {
                    ...shareImportDraft,
                    name: String(preview.querySelector('[data-share-preview-field="name"]')?.value || '').trim(),
                    url: String(preview.querySelector('[data-share-preview-field="url"]')?.value || '').trim(),
                    note: String(preview.querySelector('[data-share-preview-field="note"]')?.value || '').trim()
                };
                return;
            }

            if (shareImportDraft.kind === 'memo') {
                shareImportDraft = {
                    ...shareImportDraft,
                    title: String(preview.querySelector('[data-share-preview-field="title"]')?.value || '').trim(),
                    content: String(preview.querySelector('[data-share-preview-field="content"]')?.value || '').trim()
                };
            }
        }

        function renderShareImportCategoryAssignment(kind, selectedCategories) {
            const categories = kind === 'resource'
                ? getResourceCategories()
                : getMemoCategories();
            if (!categories.length) {
                return '<span class="nai-library-category-empty">등록된 분류가 없습니다.</span>';
            }

            const selected = new Set(normalizeLibraryCategoryList(selectedCategories));
            const ordered = [
                ...categories.filter(name => selected.has(name)),
                ...categories.filter(name => !selected.has(name))
            ];

            return ordered.map(name => `
                <button
                    type="button"
                    class="nai-library-category-chip${selected.has(name) ? ' active' : ''}"
                    data-share-preview-category="${escapeHtml(name)}"
                    aria-pressed="${selected.has(name) ? 'true' : 'false'}"
                >${escapeHtml(name)}</button>
            `).join('');
        }

        function renderShareImportPreview() {
            const wrap = $('#nai-share-import-preview');
            if (!wrap) return;

            if (!shareImportDraft) {
                wrap.hidden = true;
                wrap.innerHTML = '';
                return;
            }

            wrap.hidden = false;
            const draft = shareImportDraft;

            if (draft.kind === 'resource') {
                wrap.innerHTML = `
                    <div class="nai-import-result" data-share-preview-kind="resource">
                        <div class="nai-loader-section-title">자료실 공유 코드 미리보기</div>
                        <div class="nai-duplicate-warning" data-share-preview-duplicate-warning hidden></div>
                        <div class="nai-loader-field">
                            <label class="nai-loader-label">이름</label>
                            <input class="nai-loader-input" data-share-preview-field="name" value="${escapeHtml(draft.name || '')}">
                        </div>
                        <div class="nai-loader-field nai-library-edit-category-field">
                            <label class="nai-loader-label">분류</label>
                            <div class="nai-library-card-category-row" aria-label="가져올 자료 분류">
                                ${renderShareImportCategoryAssignment('resource', draft.categories)}
                            </div>
                        </div>
                        <div class="nai-loader-field">
                            <label class="nai-loader-label">링크</label>
                            <input class="nai-loader-input" data-share-preview-field="url" type="url" value="${escapeHtml(draft.url || '')}">
                        </div>
                        <div class="nai-loader-field" style="margin-bottom:0;">
                            <label class="nai-loader-label">메모 <span class="nai-loader-muted">(선택)</span></label>
                            <textarea class="nai-loader-textarea" data-share-preview-field="note">${escapeHtml(draft.note || '')}</textarea>
                        </div>
                        <div class="nai-edit-footer-actions" style="margin-top:10px;">
                            <button type="button" class="nai-loader-action" data-share-preview-action="cancel">취소</button>
                            <button type="button" class="nai-loader-action primary" data-share-preview-action="save">자료실에 저장</button>
                        </div>
                    </div>
                `;
                refreshShareImportDuplicateWarning();
                return;
            }

            wrap.innerHTML = `
                <div class="nai-import-result" data-share-preview-kind="memo">
                    <div class="nai-loader-section-title">메모 공유 코드 미리보기</div>
                    <div class="nai-duplicate-warning" data-share-preview-duplicate-warning hidden></div>
                    <div class="nai-loader-field">
                        <label class="nai-loader-label">제목 <span class="nai-loader-muted">(선택)</span></label>
                        <input class="nai-loader-input" data-share-preview-field="title" value="${escapeHtml(draft.title || '')}">
                    </div>
                    <div class="nai-loader-field nai-library-edit-category-field">
                        <label class="nai-loader-label">분류</label>
                        <div class="nai-library-card-category-row" aria-label="가져올 메모 분류">
                            ${renderShareImportCategoryAssignment('memo', draft.categories)}
                        </div>
                    </div>
                    <div class="nai-loader-field" style="margin-bottom:0;">
                        <label class="nai-loader-label">내용</label>
                        <textarea class="nai-loader-textarea" data-share-preview-field="content">${escapeHtml(draft.content || '')}</textarea>
                    </div>
                    <div class="nai-edit-footer-actions" style="margin-top:10px;">
                        <button type="button" class="nai-loader-action" data-share-preview-action="cancel">취소</button>
                        <button type="button" class="nai-loader-action primary" data-share-preview-action="save">메모에 저장</button>
                    </div>
                </div>
            `;
            refreshShareImportDuplicateWarning();
        }

        function refreshShareImportDuplicateWarning() {
            const preview = $('#nai-share-import-preview');
            const warning = preview?.querySelector('[data-share-preview-duplicate-warning]');
            const saveButton = preview?.querySelector('[data-share-preview-action="save"]');
            if (!shareImportDraft || !warning) return;

            let duplicate = null;
            let message = '';

            if (shareImportDraft.kind === 'resource') {
                duplicate = findResourceExactDuplicate(shareImportDraft.url || '');
                message = duplicate
                    ? '중복 · 자료실에 완전히 같은 링크가 이미 저장되어 있습니다.'
                    : '';
            } else if (shareImportDraft.kind === 'memo') {
                duplicate = findMemoExactDuplicate(shareImportDraft.content || '');
                message = duplicate
                    ? '중복 · 메모에 내용이 완전히 같은 메모가 이미 저장되어 있습니다.'
                    : '';
            }

            warning.textContent = message;
            warning.hidden = !duplicate;
            if (saveButton) {
                saveButton.disabled = !!duplicate;
                saveButton.title = duplicate ? '중복 내용을 수정하면 저장할 수 있습니다.' : '';
            }
        }

        function clearShareImportPreview() {
            shareImportDraft = null;
            renderShareImportPreview();
        }

        function saveShareImportPreview() {
            if (!shareImportDraft) return;
            syncShareImportDraftFromDom();
            const input = $('#nai-import-url');
            const status = $('#nai-import-status');
            const now = Date.now();

            if (shareImportDraft.kind === 'resource') {
                const url = normalizedExternalUrl(shareImportDraft.url || '');
                if (!url) {
                    status.textContent = '자료 링크에는 http:// 또는 https:// 주소를 입력해주세요.';
                    return;
                }

                const duplicate = findResourceExactDuplicate(url);
                if (duplicate) {
                    status.textContent = '';
                    refreshShareImportDuplicateWarning();
                    showToast('중복 자료입니다. 같은 링크가 이미 자료실에 있습니다.', 'error');
                    return;
                }

                const name = String(shareImportDraft.name || '').trim() || fallbackResourceName(url);
                const resources = getResources();
                resources.unshift({
                    id: createId(),
                    name,
                    url,
                    note: String(shareImportDraft.note || '').trim(),
                    categories: normalizeLibraryCategoryList(shareImportDraft.categories),
                    createdAt: now,
                    updatedAt: now
                });
                saveResources(resources);
                if (input) input.value = '';
                clearShareImportPreview();
                status.textContent = '';
                showToast(`"${name}" 자료를 자료실에 저장했습니다.`);
                switchTab('resources');
                return;
            }

            const content = String(shareImportDraft.content || '').trim();
            if (!content) {
                status.textContent = '메모 내용을 입력해주세요.';
                return;
            }

            const duplicate = findMemoExactDuplicate(content);
            if (duplicate) {
                status.textContent = '';
                refreshShareImportDuplicateWarning();
                showToast('중복 메모입니다. 내용이 완전히 같은 메모가 이미 있습니다.', 'error');
                return;
            }

            const title = String(shareImportDraft.title || '').trim();
            const memos = getMemos();
            memos.unshift({
                id: createId(),
                title,
                content,
                categories: normalizeLibraryCategoryList(shareImportDraft.categories),
                createdAt: now,
                updatedAt: now
            });
            saveMemos(memos);
            if (input) input.value = '';
            clearShareImportPreview();
            status.textContent = '';
            showToast(title
                ? `"${title}" 메모를 저장했습니다.`
                : '메모를 저장했습니다.');
            switchTab('memos');
        }

        function loadShareCodeFromImport() {
            const input = $('#nai-import-url');
            const status = $('#nai-import-status');
            const raw = String(input?.value || '').trim();

            if (isAnalyzing) {
                status.textContent = 'URL 분석 중에는 공유 코드를 불러올 수 없습니다. 분석이 끝난 뒤 다시 눌러주세요.';
                return;
            }

            if (!raw) {
                status.textContent = '공유 코드를 입력해주세요.';
                return;
            }

            try {
                const payload = parseShareCodePayload(raw);

                if (payload.kind === 'resource') {
                    const resource = parseResourceShareCode(raw);
                    shareImportDraft = {
                        kind: 'resource',
                        name: resource.name,
                        url: resource.url,
                        note: resource.note,
                        categories: []
                    };
                    analysisResults = [];
                    analysisMeta = null;
                    renderAnalysisResults();
                    renderShareImportPreview();
                    status.textContent = '자료실 공유 코드를 불러왔습니다. 내용을 수정한 뒤 자료실에 저장을 눌러주세요.';
                    return;
                }

                if (payload.kind === 'memo') {
                    const memo = parseMemoShareCode(raw);
                    shareImportDraft = {
                        kind: 'memo',
                        title: memo.title,
                        content: memo.content,
                        categories: []
                    };
                    analysisResults = [];
                    analysisMeta = null;
                    renderAnalysisResults();
                    renderShareImportPreview();
                    status.textContent = '메모 공유 코드를 불러왔습니다. 내용을 수정한 뒤 메모에 저장을 눌러주세요.';
                    return;
                }

                clearShareImportPreview();
                const concept = parseConceptShareCode(raw);

                analysisResultUnread = false;
                analysisUrl = '';
                analysisResults = [{
                    id: createId(),
                    selected: true,
                    suggestedName: concept.suggestedName,
                    sectionLabel: '',
                    tags: concept.tags,
                    negativeTags: concept.negativeTags,
                    characters: concept.characters,
                    note: concept.note,
                    sourceUrl: concept.sourceUrl,
                    sourcePageTitle: '',
                    _noteOpen: !!concept.note
                }];
                analysisMeta = {
                    method: 'share-code',
                    pageTitle: '확프 공유 코드'
                };
                analysisStatusText = '컨셉 공유 코드 1개를 불러왔습니다. 내용을 확인한 뒤 선택 항목 저장을 눌러주세요.';

                renderAnalysisResults();
                setGlobalAnalysisStatus(analysisStatusText);
                syncGlobalAnalyzeUi();
            } catch (error) {
                status.textContent = `공유 코드 불러오기 실패: ${error?.message || String(error)}`;
            }
        }

        function saveSelectedAnalysisResults() {
            syncAnalysisResultsFromDom();

            const url = normalizedExternalUrl($('#nai-import-url').value.trim());
            const selected = analysisResults.filter(item => item.selected);
            const status = $('#nai-import-status');

            if (!selected.length) {
                status.textContent =
                    '저장할 Prompt 세트를 하나 이상 선택해주세요.';
                return;
            }

            const invalid = selected.find(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const hasNegative =
                    !!String(item.negativeTags || '').trim();
                const hasCharacterContent = (item.characters || []).some(character =>
                    !!String(character?.prompt || '').trim() ||
                    !!String(character?.negativePrompt || '').trim()
                );

                return (
                    !String(item.suggestedName || '').trim() ||
                    (
                        !String(item.tags || '').trim() &&
                        !hasNegative &&
                        !hasCharacterContent
                    )
                );
            });

            if (invalid) {
                status.textContent =
                    '선택한 항목의 이름/Prompt를 확인해주세요.';
                return;
            }

            const duplicateSelected = selected.filter(item =>
                !!findLibraryExactDuplicate(item)
            );
            if (duplicateSelected.length) {
                refreshAnalysisDuplicateBadges();
                status.textContent = '';
                showToast(
                    duplicateSelected.length === 1
                        ? '중복 Prompt가 있습니다. 중복 표시된 항목을 수정하거나 선택 해제해주세요.'
                        : `중복 Prompt가 ${duplicateSelected.length}개 있습니다. 수정하거나 선택 해제해주세요.`,
                    'error'
                );
                return;
            }

            const library = getLibrary();
            const now = Date.now();

            const newItems = selected.map(rawItem => {
                const item = normalizeConceptRecord(rawItem);
                const characters = normalizeCharacterRows(item.characters)
                    .map(character => ({
                        name: String(character.name || '').trim(),
                        prompt: String(character.prompt || '').trim(),
                        negativePrompt: String(character.negativePrompt || '').trim()
                    }))
                    .filter(character => character.prompt || character.negativePrompt);

                return {
                    id: createId(),
                    name: String(item.suggestedName || '').trim(),
                    tags: String(item.tags || '').trim(),
                    negativeTags: String(item.negativeTags || '').trim(),
                    characters,
                    note: String(item.note || '').trim(),
                    categories: normalizeLibraryCategoryList(item.categories),
                    source: (() => {
                        const sourceUrl = normalizedExternalUrl(item.sourceUrl || '') || url;
                        const isShareCode = analysisMeta?.method === 'share-code';
                        return {
                            type: sourceUrl
                                ? detectSourceType(sourceUrl)
                                : (isShareCode ? 'ShareCode' : 'Unknown'),
                            url: sourceUrl,
                            rootUrl: isShareCode ? '' : url,
                            provider: isShareCode ? '' : getSettings().provider,
                            importMethod: analysisMeta?.method || '',
                            pageTitle: item.sourcePageTitle || ''
                        };
                    })(),
                    createdAt: now,
                    updatedAt: now
                };
            });

            saveLibrary([...newItems, ...library]);

            const savedIds = new Set(selected.map(item => item.id));

            analysisResults = analysisResults.filter(
                item => !savedIds.has(item.id)
            );

            status.textContent =
                `${newItems.length}개 Prompt 세트를 라이브러리에 저장했습니다.`;

            renderAnalysisResults();
            renderLibrary();
        }

        async function runAnalyze() {
            if (isAnalyzing) {
                setGlobalAnalysisStatus(
                    analysisStatusText || '이미 백그라운드에서 분석 중입니다.'
                );
                syncGlobalAnalyzeUi();
                return;
            }

            const urlInput = $('#nai-import-url');
            const url = String(urlInput?.value || '').trim();

            if (!url) {
                setGlobalAnalysisStatus('먼저 URL을 입력해주세요.');
                return;
            }

            if (url.startsWith(SHARE_CODE_PREFIX)) {
                setGlobalAnalysisStatus('공유 코드는 왼쪽의 공유 코드 불러오기 버튼을 눌러주세요.');
                return;
            }

            if (!normalizedExternalUrl(url)) {
                setGlobalAnalysisStatus('URL 가져오기에는 http:// 또는 https:// 주소를 입력해주세요.');
                return;
            }

            const settings = getSettings();
            const settingsError = validateSettings(settings);

            if (settingsError) {
                setGlobalAnalysisStatus(`설정 필요: ${settingsError}`);
                switchTab('settings');
                return;
            }

            clearShareImportPreview();

            isAnalyzing = true;
            analysisResultUnread = false;
            analysisUrl = url;
            analysisResults = [];
            analysisMeta = null;
            setGlobalAnalysisStatus(
                '분석 시작 · 확프창을 닫아도 백그라운드에서 계속됩니다.'
            );
            notifyGlobalAnalysisState();
            renderAnalysisResults();

            let analysisSucceeded = false;

            try {
                const result = await analyzeSharedUrl(
                    url,
                    settings,
                    message => {
                        setGlobalAnalysisStatus(message);
                        syncGlobalAnalyzeUi();
                    }
                );

                analysisResults = Array.isArray(result?.concepts)
                    ? result.concepts
                    : [];
                analysisMeta = result || null;

                renderAnalysisResults();

                const method = String(result.method || '');
                setGlobalAnalysisStatus(
                    method === 'notion-network-intercept'
                        ? `Notion 내부 API 응답 ${result.assetsVisited || 0}개에서 ${result.concepts.length}개 Prompt 세트를 찾았습니다.`
                        : method.startsWith('notion')
                            ? `Notion ${result.pagesVisited}개 페이지를 훑어서 ${result.concepts.length}개 Prompt 세트를 찾았습니다.${result.errors ? ` (${result.errors}개 항목은 읽기 실패)` : ''}`
                            : `${result.concepts.length}개 Prompt 세트를 찾았습니다. 이름/Prompt를 확인하고 저장하세요.`
                );
                analysisSucceeded = true;
                notifyGlobalAnalysisState();
            } catch (error) {
                setGlobalAnalysisStatus(
                    `분석 실패:\n${error?.message || String(error)}`
                );
                notifyGlobalAnalysisState();
            } finally {
                isAnalyzing = false;
                notifyGlobalAnalysisState();
                if (analysisSucceeded) {
                    triggerAnalysisCompletionAnimation();
                }
            }
        }

        async function runConnectionTest() {
            if (isTesting) return;

            const status = $('#nai-settings-status');
            const button = $('[data-action="test-settings"]');
            const settings = collectSettingsFromForm();
            const error = validateSettings(settings);

            if (error) {
                status.textContent = error;
                return;
            }

            saveSettings(settings);

            isTesting = true;
            button.disabled = true;
            button.innerHTML =
                '<span class="nai-loading">테스트 중</span>';

            try {
                const result = await testProviderConnection(settings);
                status.textContent = result;
            } catch (testError) {
                status.textContent =
                    `연결 실패: ${testError?.message || String(testError)}`;
            } finally {
                isTesting = false;
                button.disabled = false;
                button.textContent = '연결 테스트';
            }
        }

        $$('.nai-loader-tab').forEach(button => {
            button.addEventListener('click', () => {
                switchTab(button.dataset.tab);
            });
        });

        $$('.nai-provider-button').forEach(button => {
            button.addEventListener('click', () => {
                currentProvider = button.dataset.provider;
                updateProviderUI();
            });
        });

        $$('[data-create-toggle]').forEach(button => {
            button.addEventListener('click', () => {
                const kind = button.dataset.createToggle;
                const isOpen = button.getAttribute('aria-expanded') === 'true';

                if (kind === 'library') {
                    if (isOpen) syncManualDraftFromDom();
                    setCreatePanelOpen('library', !isOpen);
                    if (!isOpen) {
                        requestAnimationFrame(() => {
                            $('#nai-manual-editor-root [data-manual-field="name"]')?.focus();
                        });
                    }
                    return;
                }

                if (kind === 'resources') {
                    setCreatePanelOpen('resources', !isOpen);
                    if (!isOpen) requestAnimationFrame(() => $('#nai-resource-name')?.focus());
                    return;
                }

                if (kind === 'memos') {
                    setCreatePanelOpen('memos', !isOpen);
                    if (!isOpen) requestAnimationFrame(() => $('#nai-memo-title')?.focus());
                }
            });
        });

        function bindInfoCategoryBar(kind) {
            const config = getInfoCategoryConfig(kind);
            const bar = $(config.bar);
            if (!bar) return;

            bar.addEventListener('click', handleInfoCategoryBarClick);
            bar.addEventListener('change', event => {
                const input = event.target.closest('[data-info-category-rename]');
                if (!input || input.dataset.infoCategoryScope !== kind) return;
                renameInfoCategory(kind, input.dataset.infoCategoryRename, input.value);
            });
            bar.addEventListener('keydown', event => {
                const input = event.target.closest('[data-info-category-rename]');
                if (!input || input.dataset.infoCategoryScope !== kind) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    input.value = input.dataset.infoCategoryRename || '';
                    input.blur();
                }
            });
        }

        bindInfoCategoryBar('resources');
        bindInfoCategoryBar('memos');

        $('#nai-resource-search').addEventListener('input', renderResources);

        function getResourceDragCards(list) {
            return [...list.querySelectorAll('[data-resource-id]')];
        }

        function finishResourceDrag({ cancel = false } = {}) {
            const state = resourceDragState;
            if (!state) return;

            const { list, card, handle, pointerId, moved } = state;
            try {
                if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            } catch (_) {}

            handle.classList.remove('dragging');
            card.classList.remove('nai-resource-dragging');
            list.classList.remove('nai-resource-drag-active');
            resourceDragState = null;

            if (moved) {
                resourceDragSuppressClickUntil = Date.now() + 550;
            }

            if (cancel) {
                renderResources();
                return;
            }

            if (!moved) return;
            const orderedIds = getResourceDragCards(list)
                .map(node => node.dataset.resourceId)
                .filter(Boolean);
            saveVisibleResourceOrder(orderedIds);
            renderResources();
        }

        function handleResourceDragMove(event) {
            const state = resourceDragState;
            if (!state || event.pointerId !== state.pointerId) return;

            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (!state.moved && Math.hypot(dx, dy) < 5) return;

            if (!state.moved) {
                state.moved = true;
                state.list.classList.add('nai-resource-drag-active');
                state.card.classList.add('nai-resource-dragging');
                state.handle.classList.add('dragging');
            }

            event.preventDefault();

            const candidates = document.elementsFromPoint(event.clientX, event.clientY)
                .map(node => node.closest?.('[data-resource-id]'))
                .filter(Boolean);
            const target = candidates.find(node => node !== state.card && node.parentElement === state.list);
            if (!target) return;

            const rect = target.getBoundingClientRect();
            const nearSameRow = Math.abs(event.clientY - (rect.top + rect.height / 2)) <= rect.height * 0.34;
            const before = nearSameRow
                ? event.clientX < rect.left + rect.width / 2
                : event.clientY < rect.top + rect.height / 2;

            if (before) {
                if (state.card.nextElementSibling !== target) {
                    state.list.insertBefore(state.card, target);
                }
            } else if (target.nextElementSibling !== state.card) {
                state.list.insertBefore(state.card, target.nextElementSibling);
            }
        }

        function startResourceDrag(event) {
            const handle = event.target.closest('[data-resource-drag-handle]');
            if (!handle || event.button !== 0) return;
            const card = handle.closest('.nai-resource-card[data-resource-id]');
            const list = handle.closest('#nai-resource-list');
            if (!card || !list) return;

            event.preventDefault();
            event.stopPropagation();
            resourceDragState = {
                list,
                card,
                handle,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false
            };

            try {
                handle.setPointerCapture?.(event.pointerId);
            } catch (_) {}
        }

        function openResourceCard(card) {
            if (!card || card.classList.contains('nai-info-edit-card')) return false;
            const id = card.dataset.resourceId;
            if (!id) return false;
            const item = getResources()
                .map(normalizeResourceRecord)
                .find(resource => resource.id === id);
            const url = normalizedExternalUrl(item?.url);
            if (!url) return false;
            window.open(url, '_blank', 'noopener,noreferrer');
            return true;
        }

        $('#nai-resource-list').addEventListener('pointerdown', startResourceDrag);
        $('#nai-resource-list').addEventListener('pointermove', handleResourceDragMove);
        $('#nai-resource-list').addEventListener('pointerup', event => {
            if (resourceDragState && event.pointerId === resourceDragState.pointerId) {
                finishResourceDrag();
            }
        });
        $('#nai-resource-list').addEventListener('pointercancel', event => {
            if (resourceDragState && event.pointerId === resourceDragState.pointerId) {
                finishResourceDrag({ cancel: true });
            }
        });

        $('#nai-resource-list').addEventListener('click', event => {
            if (Date.now() < resourceDragSuppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const categoryButton = event.target.closest('[data-info-category-assign][data-info-category-scope="resources"]');
            if (categoryButton) {
                handleInfoCategoryAssignment(categoryButton);
                return;
            }

            const button = event.target.closest('[data-resource-action]');
            if (button) {
                handleResourceAction(button);
                return;
            }

            const card = event.target.closest('.nai-resource-card[data-resource-id]');
            if (!card) return;

            /* 삭제/수정/순서 버튼이 있는 조작 구간은 카드 링크에서 제외. */
            if (event.target.closest('[data-resource-card-actions], button, input, textarea, select, a')) {
                return;
            }
            openResourceCard(card);
        });

        $('#nai-resource-list').addEventListener('keydown', event => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const card = event.target.closest('.nai-resource-card[data-resource-id]');
            if (!card || event.target !== card) return;
            event.preventDefault();
            openResourceCard(card);
        });
        $('#nai-resource-create-wrap').addEventListener('click', event => {
            const categoryButton = event.target.closest('[data-resource-create-category]');
            if (categoryButton) {
                const name = normalizeLibraryCategoryName(categoryButton.dataset.resourceCreateCategory);
                if (!name) return;
                if (resourceCreateCategories.has(name)) resourceCreateCategories.delete(name);
                else resourceCreateCategories.add(name);
                renderResourceCreateCategoryAssignment();
                return;
            }

            const button = event.target.closest('[data-resource-action]');
            if (button) handleResourceAction(button);
        });

        $('#nai-memo-search').addEventListener('input', renderMemos);

        function getMemoDragCards(list) {
            return [...list.querySelectorAll('.nai-memo-card[data-memo-id]')];
        }

        function finishMemoDrag({ cancel = false } = {}) {
            const state = memoDragState;
            if (!state) return;

            const { list, card, handle, pointerId, moved } = state;
            try {
                if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            } catch (_) {}

            handle.classList.remove('dragging');
            card.classList.remove('nai-memo-dragging');
            list.classList.remove('nai-memo-drag-active');
            memoDragState = null;

            if (moved) memoDragSuppressClickUntil = Date.now() + 550;

            if (cancel) {
                renderMemos();
                return;
            }

            if (!moved) return;
            const orderedIds = getMemoDragCards(list)
                .map(node => node.dataset.memoId)
                .filter(Boolean);
            saveVisibleMemoOrder(orderedIds);
            renderMemos();
        }

        function handleMemoDragMove(event) {
            const state = memoDragState;
            if (!state || event.pointerId !== state.pointerId) return;

            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (!state.moved && Math.hypot(dx, dy) < 5) return;

            if (!state.moved) {
                state.moved = true;
                state.list.classList.add('nai-memo-drag-active');
                state.card.classList.add('nai-memo-dragging');
                state.handle.classList.add('dragging');
            }

            event.preventDefault();

            const candidates = document.elementsFromPoint(event.clientX, event.clientY)
                .map(node => node.closest?.('.nai-memo-card[data-memo-id]'))
                .filter(Boolean);
            const target = candidates.find(node => node !== state.card && node.parentElement === state.list);
            if (!target) return;

            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
                if (state.card.nextElementSibling !== target) state.list.insertBefore(state.card, target);
            } else if (target.nextElementSibling !== state.card) {
                state.list.insertBefore(state.card, target.nextElementSibling);
            }
        }

        function startMemoDrag(event) {
            const handle = event.target.closest('[data-memo-drag-handle]');
            if (!handle || event.button !== 0) return;
            const card = handle.closest('.nai-memo-card[data-memo-id]');
            const list = handle.closest('#nai-memo-list');
            if (!card || !list) return;

            event.preventDefault();
            event.stopPropagation();
            memoDragState = {
                list,
                card,
                handle,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false
            };

            try {
                handle.setPointerCapture?.(event.pointerId);
            } catch (_) {}
        }

        $('#nai-memo-list').addEventListener('pointerdown', startMemoDrag);
        $('#nai-memo-list').addEventListener('pointermove', handleMemoDragMove);
        $('#nai-memo-list').addEventListener('pointerup', event => {
            if (memoDragState && event.pointerId === memoDragState.pointerId) finishMemoDrag();
        });
        $('#nai-memo-list').addEventListener('pointercancel', event => {
            if (memoDragState && event.pointerId === memoDragState.pointerId) {
                finishMemoDrag({ cancel: true });
            }
        });

        $('#nai-memo-list').addEventListener('click', event => {
            if (Date.now() < memoDragSuppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            const categoryButton = event.target.closest('[data-info-category-assign][data-info-category-scope="memos"]');
            if (categoryButton) {
                handleInfoCategoryAssignment(categoryButton);
                return;
            }
            const button = event.target.closest('[data-memo-action]');
            if (button) handleMemoAction(button);
        });
        $('#nai-memo-create-wrap').addEventListener('click', event => {
            const categoryButton = event.target.closest('[data-memo-create-category]');
            if (categoryButton) {
                const name = normalizeLibraryCategoryName(categoryButton.dataset.memoCreateCategory);
                if (!name) return;
                if (memoCreateCategories.has(name)) memoCreateCategories.delete(name);
                else memoCreateCategories.add(name);
                renderMemoCreateCategoryAssignment();
                return;
            }

            const button = event.target.closest('[data-memo-action]');
            if (button) handleMemoAction(button);
        });

        $('[data-action="close"]').addEventListener(
            'click',
            () => overlay.remove()
        );

        function setAllAnalysisSelection(selected) {
            syncAnalysisResultsFromDom();

            analysisResults.forEach(item => {
                item.selected = !!selected;
            });

            $$('#nai-ai-results [data-result-field="selected"]').forEach(checkbox => {
                checkbox.checked = !!selected;
            });
        }

        $('[data-action="select-all-results"]').addEventListener(
            'click',
            () => setAllAnalysisSelection(true)
        );

        $('[data-action="clear-all-results"]').addEventListener(
            'click',
            () => setAllAnalysisSelection(false)
        );

        $('[data-action="save-selected"]').addEventListener(
            'click',
            saveSelectedAnalysisResults
        );

        $('#nai-share-import-preview').addEventListener('input', event => {
            if (!event.target.closest('[data-share-preview-field]')) return;
            syncShareImportDraftFromDom();
            refreshShareImportDuplicateWarning();
        });

        $('#nai-share-import-preview').addEventListener('click', event => {
            const categoryButton = event.target.closest('[data-share-preview-category]');
            if (categoryButton && shareImportDraft) {
                syncShareImportDraftFromDom();
                const name = normalizeLibraryCategoryName(categoryButton.dataset.sharePreviewCategory);
                if (!name) return;
                const selected = new Set(normalizeLibraryCategoryList(shareImportDraft.categories));
                if (selected.has(name)) selected.delete(name);
                else selected.add(name);
                shareImportDraft = {
                    ...shareImportDraft,
                    categories: [...selected]
                };
                renderShareImportPreview();
                return;
            }

            const action = event.target.closest('[data-share-preview-action]')?.dataset.sharePreviewAction;
            if (action === 'cancel') {
                clearShareImportPreview();
                $('#nai-import-status').textContent = '';
                return;
            }
            if (action === 'save') saveShareImportPreview();
        });

        $('[data-action="load-share-code"]').addEventListener(
            'click',
            loadShareCodeFromImport
        );

        $('[data-action="analyze"]').addEventListener(
            'click',
            runAnalyze
        );

        $('[data-action="reset-archive"]').addEventListener(
            'click',
            () => {
                const confirmed = window.confirm(
                    '정말 전체 초기화할까요?\n\n' +
                    '라이브러리 · 자료실 · 메모와 각 분류가 모두 삭제됩니다.\n' +
                    'API 키와 AI 연결 설정은 유지됩니다.\n\n' +
                    '필요한 데이터는 백업 파일로 받아두셨나요?\n\n' +
                    '[확인]을 누르면 즉시 삭제됩니다.'
                );
                if (!confirmed) return;

                saveLibrary([]);
                saveLibraryCategories([]);
                saveResources([]);
                saveResourceCategories([]);
                saveMemos([]);
                saveMemoCategories([]);

                activeLibraryCategories.clear();
                activeResourceCategories.clear();
                activeMemoCategories.clear();
                expandedLibraryCards.clear();
                expandedLibraryNotes.clear();

                editingId = null;
                editingDraft = null;
                resourceEditingId = null;
                resourceEditingDraft = null;
                memoEditingId = null;
                memoEditingDraft = null;
                libraryCreateOpen = false;
                resourceCreateOpen = false;
                memoCreateOpen = false;
                resourceCreateCategories.clear();
                memoCreateCategories.clear();
                manualDraft = {
                    name: '',
                    note: '',
                    sourceUrl: '',
                    tags: '',
                    negativeTags: '',
                    characters: [],
                    categories: []
                };

                visibleLibraryIds = [];
                visibleResourceIds = [];
                visibleMemoIds = [];
                libraryDragState = null;
                resourceDragState = null;
                memoDragState = null;

                backupItemSelection.library.clear();
                backupItemSelection.resources.clear();
                backupItemSelection.memos.clear();
                backupSelectionInitialized = false;
                restoreDraft = null;

                const restorePreview = $('#nai-restore-preview');
                if (restorePreview) {
                    restorePreview.hidden = true;
                    restorePreview.innerHTML = '';
                }

                renderLibrary();
                renderResources();
                renderMemos();
                renderBackupSelection();
                showToast('라이브러리 · 자료실 · 메모를 전체 초기화했습니다. API 설정은 유지됩니다.');
            }
        );

        $('[data-action="save-settings"]').addEventListener(
            'click',
            () => {
                const settings = collectSettingsFromForm();
                const error = validateSettings(settings);

                if (error) {
                    $('#nai-settings-status').textContent = error;
                    return;
                }

                saveSettings(settings);

                $('#nai-settings-status').textContent =
                    `${providerLabel(settings.provider)} 설정을 저장했습니다.`;
            }
        );

        $('[data-action="test-settings"]').addEventListener(
            'click',
            runConnectionTest
        );

        $('#nai-manual-editor-root').addEventListener(
            'click',
            event => {
                const noteToggle = event.target.closest('[data-manual-note-toggle]');
                if (noteToggle) {
                    syncManualDraftFromDom();
                    const body = $('#nai-manual-editor-root').querySelector('[data-manual-note-body]');
                    const nextOpen = noteToggle.getAttribute('aria-expanded') !== 'true';
                    manualDraft._noteOpen = nextOpen;
                    noteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    noteToggle.textContent = `메모 ${nextOpen ? '▼' : '◀'}`;
                    if (body) body.hidden = !nextOpen;
                    if (nextOpen) {
                        requestAnimationFrame(() => {
                            const textarea = body?.querySelector('[data-manual-field="note"]');
                            if (textarea) fitAnalysisTextarea(textarea);
                        });
                    }
                    return;
                }

                const categoryButton = event.target.closest('[data-manual-category-assign]');
                if (categoryButton) {
                    syncManualDraftFromDom();
                    const name = normalizeLibraryCategoryName(categoryButton.dataset.manualCategoryAssign);
                    if (!name) return;
                    const selected = new Set(normalizeLibraryCategoryList(manualDraft.categories));
                    if (selected.has(name)) selected.delete(name);
                    else selected.add(name);
                    manualDraft.categories = normalizeLibraryCategoryList([...selected]);
                    renderManualCreateCategoryAssignment();
                    return;
                }

                const tabButton = event.target.closest('[data-analysis-prompt-tab]');
                if (tabButton) {
                    activateAnalysisPromptTab(
                        tabButton.closest('.nai-analysis-prompt-editor'),
                        tabButton.dataset.analysisPromptTab
                    );
                    return;
                }

                const action = event.target.closest('[data-manual-edit-action]');
                if (action) {
                    syncManualDraftFromDom();

                    if (action.dataset.manualEditAction === 'add-character') {
                        const characters = Array.isArray(manualDraft.characters)
                            ? [...manualDraft.characters]
                            : [];
                        characters.push({
                            name: `Character ${characters.length + 1}`,
                            prompt: '',
                            negativePrompt: '',
                            _analysisDraft: true
                        });
                        manualDraft.characters = characters;
                        renderManualAddEditor();
                        requestAnimationFrame(() => {
                            const prompts = [...$('#nai-manual-editor-root').querySelectorAll(
                                '[data-manual-character-field="prompt"]'
                            )];
                            prompts.at(-1)?.focus();
                        });
                        return;
                    }

                    if (action.dataset.manualEditAction === 'remove-character') {
                        const characterCard = action.closest('[data-manual-character-index]');
                        const characterIndex = Number(characterCard?.dataset.manualCharacterIndex);
                        if (!Number.isInteger(characterIndex)) return;

                        const characters = Array.isArray(manualDraft.characters)
                            ? [...manualDraft.characters]
                            : [];
                        characters.splice(characterIndex, 1);
                        manualDraft.characters = renumberAnalysisCharacters(characters);
                        renderManualAddEditor();
                        return;
                    }

                    if (action.dataset.manualEditAction === 'cancel-add') {
                        manualDraft = {
                            name: '',
                            note: '',
                            sourceUrl: '',
                            tags: '',
                            negativeTags: '',
                            characters: [],
                            categories: []
                        };
                        $('#nai-manual-editor-root').innerHTML = '';
                        $('#nai-manual-status').textContent = '';
                        setCreatePanelOpen('library', false);
                        return;
                    }
                }

                const saveButton = event.target.closest('[data-action="save-import"]');
                if (saveButton) {
                    saveImportedConcept();
                }
            }
        );

        $('[data-library-search-submit]')?.addEventListener('click', () => {
            const input = $('#nai-library-search');
            if (!input) return;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.focus();
        });

        $('#nai-library-search').addEventListener(
            'input',
            () => {
                expandedLibraryCards.clear();
                expandedLibraryNotes.clear();
                renderLibrary();
            }
        );

        $('#nai-library-category-bar').addEventListener(
            'click',
            event => {
                const editToggle = event.target.closest('[data-library-category-edit-toggle]');
                if (editToggle) {
                    libraryCategoryEditMode = !libraryCategoryEditMode;
                    renderLibraryCategoryBar();
                    return;
                }

                const addButton = event.target.closest('[data-library-category-add]');
                if (addButton) {
                    const raw = window.prompt('새 분류 이름');
                    if (raw === null) return;

                    const name = normalizeLibraryCategoryName(raw);
                    if (!name) return;
                    if (name === '전체' || name === '+') {
                        $('#nai-library-status').textContent = '이 이름은 분류로 사용할 수 없습니다.';
                        return;
                    }

                    const categories = getLibraryCategories();
                    if (categories.includes(name)) {
                        $('#nai-library-status').textContent = `"${name}" 분류는 이미 있습니다.`;
                        return;
                    }

                    categories.push(name);
                    saveLibraryCategories(categories);
                    renderLibrary();
                    $('#nai-library-status').textContent = `"${name}" 분류를 추가했습니다.`;
                    return;
                }

                const moveButton = event.target.closest('[data-library-category-move]');
                if (moveButton) {
                    moveLibraryCategory(
                        moveButton.dataset.libraryCategoryName,
                        moveButton.dataset.libraryCategoryMove
                    );
                    return;
                }

                const deleteButton = event.target.closest('[data-library-category-delete]');
                if (deleteButton) {
                    deleteLibraryCategory(deleteButton.dataset.libraryCategoryDelete);
                    return;
                }

                const filterButton = event.target.closest('[data-library-category-filter]');
                if (!filterButton) return;

                const name = filterButton.dataset.libraryCategoryFilter;
                if (name === '__all__') {
                    activeLibraryCategories.clear();
                } else if (activeLibraryCategories.has(name)) {
                    activeLibraryCategories.delete(name);
                } else {
                    activeLibraryCategories.add(name);
                }

                expandedLibraryCards.clear();
                expandedLibraryNotes.clear();
                renderLibrary();
            }
        );

        $('#nai-library-category-bar').addEventListener(
            'change',
            event => {
                const input = event.target.closest('[data-library-category-rename]');
                if (!input) return;
                renameLibraryCategory(
                    input.dataset.libraryCategoryRename,
                    input.value
                );
            }
        );

        $('#nai-library-category-bar').addEventListener(
            'keydown',
            event => {
                const input = event.target.closest('[data-library-category-rename]');
                if (!input) return;
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                }
                if (event.key === 'Escape') {
                    event.preventDefault();
                    input.value = input.dataset.libraryCategoryRename || '';
                    input.blur();
                }
            }
        );

        function finishLibraryDrag({ cancel = false } = {}) {
            const state = libraryDragState;
            if (!state) return;

            const { list, card, handle, pointerId, moved } = state;
            try {
                if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
            } catch (_) {}

            handle.classList.remove('dragging');
            card.classList.remove('nai-library-dragging');
            list.classList.remove('nai-library-drag-active');
            libraryDragState = null;

            if (moved) libraryDragSuppressClickUntil = Date.now() + 550;

            if (cancel) {
                renderLibrary();
                return;
            }

            if (!moved) return;
            const orderedIds = [...list.querySelectorAll('[data-concept-id]')]
                .map(node => node.dataset.conceptId)
                .filter(Boolean);
            saveVisibleLibraryOrder(orderedIds);
            renderLibrary();
        }

        function handleLibraryDragMove(event) {
            const state = libraryDragState;
            if (!state || event.pointerId !== state.pointerId) return;

            const dx = event.clientX - state.startX;
            const dy = event.clientY - state.startY;
            if (!state.moved && Math.hypot(dx, dy) < 5) return;

            if (!state.moved) {
                state.moved = true;
                state.list.classList.add('nai-library-drag-active');
                state.card.classList.add('nai-library-dragging');
                state.handle.classList.add('dragging');
            }

            event.preventDefault();

            const candidates = document.elementsFromPoint(event.clientX, event.clientY)
                .map(node => node.closest?.('.nai-concept-card[data-concept-id]:not([data-library-edit-card])'))
                .filter(Boolean);
            const target = candidates.find(node => node !== state.card && node.parentElement === state.list);
            if (!target) return;

            const rect = target.getBoundingClientRect();
            const before = event.clientY < rect.top + rect.height / 2;
            if (before) {
                if (state.card.nextElementSibling !== target) state.list.insertBefore(state.card, target);
            } else if (target.nextElementSibling !== state.card) {
                state.list.insertBefore(state.card, target.nextElementSibling);
            }
        }

        function startLibraryDrag(event) {
            const handle = event.target.closest('[data-library-drag-handle]');
            if (!handle || event.button !== 0) return;
            const card = handle.closest('.nai-concept-card[data-concept-id]:not([data-library-edit-card])');
            const list = handle.closest('#nai-library-list');
            if (!card || !list) return;

            event.preventDefault();
            event.stopPropagation();
            libraryDragState = {
                list,
                card,
                handle,
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                moved: false
            };

            try {
                handle.setPointerCapture?.(event.pointerId);
            } catch (_) {}
        }

        $('#nai-library-list').addEventListener('pointerdown', startLibraryDrag);
        $('#nai-library-list').addEventListener('pointermove', handleLibraryDragMove);
        $('#nai-library-list').addEventListener('pointerup', event => {
            if (libraryDragState && event.pointerId === libraryDragState.pointerId) {
                finishLibraryDrag();
            }
        });
        $('#nai-library-list').addEventListener('pointercancel', event => {
            if (libraryDragState && event.pointerId === libraryDragState.pointerId) {
                finishLibraryDrag({ cancel: true });
            }
        });

        $('#nai-library-list').addEventListener(
            'click',
            event => {
                if (Date.now() < libraryDragSuppressClickUntil) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                if (event.target.closest('[data-library-drag-handle]')) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }

                const editNoteToggle = event.target.closest('[data-library-edit-note-toggle]');
                if (editNoteToggle) {
                    syncLibraryEditDraftFromDom();
                    if (!editingDraft) return;

                    const card = editNoteToggle.closest('[data-library-edit-card]');
                    const body = card?.querySelector('[data-library-edit-note-body]');
                    const nextOpen = editNoteToggle.getAttribute('aria-expanded') !== 'true';
                    editingDraft._noteOpen = nextOpen;
                    editNoteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    editNoteToggle.textContent = `메모 ${nextOpen ? '▼' : '◀'}`;
                    if (body) body.hidden = !nextOpen;

                    if (nextOpen) {
                        requestAnimationFrame(() => {
                            const textarea = body?.querySelector('[data-edit-field="note"]');
                            if (textarea) fitAnalysisTextarea(textarea);
                        });
                    }
                    return;
                }

                const tabButton = event.target.closest('[data-analysis-prompt-tab]');
                if (tabButton && tabButton.closest('[data-library-edit-card]')) {
                    activateAnalysisPromptTab(
                        tabButton.closest('.nai-analysis-prompt-editor'),
                        tabButton.dataset.analysisPromptTab
                    );
                    return;
                }

                const editAction = event.target.closest('[data-library-edit-action]');
                if (editAction) {
                    syncLibraryEditDraftFromDom();
                    if (!editingDraft) return;

                    if (editAction.dataset.libraryEditAction === 'add-character') {
                        const characters = Array.isArray(editingDraft.characters)
                            ? [...editingDraft.characters]
                            : [];
                        characters.push({
                            name: `Character ${characters.length + 1}`,
                            prompt: '',
                            negativePrompt: '',
                            _analysisDraft: true
                        });
                        editingDraft.characters = characters;
                        renderLibrary();

                        requestAnimationFrame(() => {
                            const prompts = [...$('#nai-library-list').querySelectorAll(
                                '[data-library-edit-card] [data-edit-character-field="prompt"]'
                            )];
                            prompts.at(-1)?.focus();
                        });
                        return;
                    }

                    if (editAction.dataset.libraryEditAction === 'remove-character') {
                        const characterCard = editAction.closest('[data-edit-character-index]');
                        const characterIndex = Number(characterCard?.dataset.editCharacterIndex);
                        if (!Number.isInteger(characterIndex)) return;

                        const characters = Array.isArray(editingDraft.characters)
                            ? [...editingDraft.characters]
                            : [];
                        characters.splice(characterIndex, 1);
                        editingDraft.characters = renumberAnalysisCharacters(characters);
                        renderLibrary();
                        return;
                    }
                }

                const categoryAssign = event.target.closest('[data-library-category-assign]');
                if (categoryAssign) {
                    const card = categoryAssign.closest('[data-concept-id]');
                    const id = card?.dataset.conceptId;
                    const name = normalizeLibraryCategoryName(categoryAssign.dataset.libraryCategoryAssign);
                    if (!id || !name) return;

                    const isEditCard = !!card?.matches('[data-library-edit-card]');
                    if (isEditCard) syncLibraryEditDraftFromDom();

                    const library = getLibrary();
                    const index = library.findIndex(row => row.id === id);
                    if (index < 0) return;

                    const item = normalizeConceptRecord(library[index]);
                    const sourceCategories =
                        isEditCard && editingDraft?.id === id
                            ? editingDraft.categories
                            : item.categories;
                    const selected = new Set(normalizeLibraryCategoryList(sourceCategories));
                    if (selected.has(name)) selected.delete(name);
                    else selected.add(name);

                    const nextCategories = normalizeLibraryCategoryList([...selected]);
                    if (isEditCard && editingDraft?.id === id) {
                        editingDraft.categories = nextCategories;
                    }

                    library[index] = {
                        ...item,
                        categories: nextCategories,
                        updatedAt: Date.now()
                    };
                    saveLibrary(library);
                    renderLibrary();
                    return;
                }

                const cardToggle = event.target.closest('[data-library-card-toggle]');
                if (cardToggle && !event.target.closest('[data-concept-action]')) {
                    const card = cardToggle.closest('[data-concept-id]');
                    const id = card?.dataset.conceptId;
                    if (!id) return;

                    const nextOpen = !expandedLibraryCards.has(id);
                    if (nextOpen) expandedLibraryCards.add(id);
                    else expandedLibraryCards.delete(id);

                    renderLibrary();
                    return;
                }

                const noteToggle = event.target.closest('[data-library-note-toggle]');
                if (noteToggle) {
                    const card = noteToggle.closest('[data-concept-id]');
                    const id = card?.dataset.conceptId;
                    if (!id) return;

                    const body = card.querySelector('[data-library-note-body]');
                    const textarea = body?.querySelector('[data-library-note]');
                    const nextOpen = noteToggle.getAttribute('aria-expanded') !== 'true';

                    noteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    noteToggle.classList.toggle('nai-library-note-active', nextOpen);
                    if (body) body.hidden = !nextOpen;
                    if (nextOpen) expandedLibraryNotes.add(id);
                    else expandedLibraryNotes.delete(id);

                    if (nextOpen && textarea) {
                        requestAnimationFrame(() => fitAnalysisTextarea(textarea));
                    }
                    return;
                }

                const button = event.target.closest('[data-concept-action]');
                if (button) {
                    handleConceptAction(button);
                }
            }
        );

        $('#nai-library-list').addEventListener(
            'input',
            event => {
                const noteField = event.target.closest('[data-library-note]');
                if (!noteField) return;

                const card = noteField.closest('[data-concept-id]');
                const id = card?.dataset.conceptId;
                if (!id) return;

                const value = noteField.value;
                const preview = card.querySelector('[data-library-note-preview]');
                if (preview) {
                    preview.textContent = value.trim();
                    preview.hidden = !value.trim();
                }

                const separator = card.querySelector('[data-library-note-separator]');
                if (separator) separator.hidden = !value.trim();

                scheduleLibraryNoteSave(id, value);
            }
        );

        $('#nai-library-list').addEventListener(
            'focusout',
            event => {
                const noteField = event.target.closest('[data-library-note]');
                if (!noteField) return;

                const card = noteField.closest('[data-concept-id]');
                const id = card?.dataset.conceptId;
                if (!id) return;
                persistLibraryNote(id, noteField.value);
            }
        );



        $('#nai-ai-results').addEventListener(
            'change',
            event => {
                const card = event.target.closest('[data-result-id]');
                if (!card) return;
                syncAnalysisResultsFromDom();
                refreshAnalysisDuplicateBadges();
            }
        );

        $('#nai-ai-results').addEventListener(
            'input',
            event => {
                const field = event.target.closest(
                    '[data-result-field="tags"], [data-result-field="negativeTags"], [data-result-character-field="prompt"], [data-result-character-field="negativePrompt"]'
                );
                if (!field) return;
                syncAnalysisResultsFromDom();
                refreshAnalysisDuplicateBadges();
            }
        );

        $('#nai-ai-results').addEventListener(
            'click',
            event => {
                const noteToggle = event.target.closest('[data-result-note-toggle]');
                if (noteToggle) {
                    const card = noteToggle.closest('[data-result-id]');
                    const item = analysisResults.find(
                        row => row.id === card?.dataset.resultId
                    );
                    const body = card?.querySelector('[data-result-note-body]');
                    const nextOpen = noteToggle.getAttribute('aria-expanded') !== 'true';
                    if (item) item._noteOpen = nextOpen;
                    noteToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
                    noteToggle.textContent = `메모 ${nextOpen ? '▼' : '◀'}`;
                    if (body) body.hidden = !nextOpen;
                    if (nextOpen) {
                        requestAnimationFrame(() => {
                            const textarea = body?.querySelector('[data-result-field="note"]');
                            if (textarea) fitAnalysisTextarea(textarea);
                        });
                    }
                    return;
                }

                const categoryButton = event.target.closest(
                    '[data-result-category-assign]'
                );
                if (categoryButton) {
                    const card = categoryButton.closest('[data-result-id]');
                    if (!card) return;

                    syncAnalysisResultsFromDom();
                    const item = analysisResults.find(
                        row => row.id === card.dataset.resultId
                    );
                    if (!item) return;

                    const name = normalizeLibraryCategoryName(
                        categoryButton.dataset.resultCategoryAssign
                    );
                    if (!name) return;

                    const selected = new Set(
                        normalizeLibraryCategoryList(item.categories)
                    );
                    if (selected.has(name)) selected.delete(name);
                    else selected.add(name);
                    item.categories = normalizeLibraryCategoryList([...selected]);

                    renderAnalysisResults();
                    return;
                }

                const tabButton = event.target.closest(
                    '[data-analysis-prompt-tab]'
                );
                if (tabButton) {
                    const editor = tabButton.closest('[data-result-prompt-editor]');
                    activateAnalysisPromptTab(
                        editor,
                        tabButton.dataset.analysisPromptTab
                    );
                    return;
                }

                const actionButton = event.target.closest(
                    '[data-result-action]'
                );
                if (!actionButton) return;

                const card = actionButton.closest('[data-result-id]');
                if (!card) return;

                syncAnalysisResultsFromDom();

                const item = analysisResults.find(
                    row => row.id === card.dataset.resultId
                );
                if (!item) return;

                if (actionButton.dataset.resultAction === 'add-character') {
                    const characters = normalizeCharacterRows(item.characters);
                    characters.push({
                        name: nextAnalysisCharacterName(characters),
                        prompt: '',
                        negativePrompt: '',
                        _analysisDraft: true
                    });
                    item.characters = characters;

                    renderAnalysisResults();

                    requestAnimationFrame(() => {
                        const refreshed = $$('#nai-ai-results [data-result-id]').find(
                            row => row.dataset.resultId === item.id
                        );
                        const prompts = refreshed
                            ? [...refreshed.querySelectorAll(
                                '[data-result-character-field="prompt"]'
                            )]
                            : [];
                        prompts.at(-1)?.focus();
                    });
                    return;
                }

                if (actionButton.dataset.resultAction === 'remove-character') {
                    const characterCard = actionButton.closest(
                        '[data-result-character-index]'
                    );
                    const characterIndex = Number(
                        characterCard?.dataset.resultCharacterIndex
                    );
                    if (!Number.isInteger(characterIndex)) return;

                    const characters = normalizeCharacterRows(item.characters);
                    characters.splice(characterIndex, 1);
                    item.characters = renumberAnalysisCharacters(characters);
                    renderAnalysisResults();
                }
            }
        );

        overlay.addEventListener('mousedown', event => {
            if (event.target === overlay) {
                overlay.remove();
            }
        });

        document.addEventListener(
            'keydown',
            function onKeydown(event) {
                if (!document.getElementById(MODAL_ID)) {
                    document.removeEventListener(
                        'keydown',
                        onKeydown
                    );
                    return;
                }

                if (event.key === 'Escape') {
                    overlay.remove();
                    document.removeEventListener(
                        'keydown',
                        onKeydown
                    );
                }
            }
        );

        const onGlobalAnalysisState = () => {
            if (!overlay.isConnected) {
                document.removeEventListener(
                    ANALYSIS_STATE_EVENT,
                    onGlobalAnalysisState
                );
                return;
            }

            renderAnalysisResults();
            syncGlobalAnalyzeUi();
        };
        document.addEventListener(
            ANALYSIS_STATE_EVENT,
            onGlobalAnalysisState
        );

        loadSettingsIntoForm();

        if (analysisUrl) {
            const importUrl = $('#nai-import-url');
            if (importUrl) importUrl.value = analysisUrl;
        }
        if (analysisStatusText) {
            const importStatus = $('#nai-import-status');
            if (importStatus) importStatus.textContent = analysisStatusText;
        }

        renderLibrary();
        renderAnalysisResults();
        syncGlobalAnalyzeUi();
        switchTab(activeTab);
    }

    /* =====================================================================
     * NAI Archive · Personal Notion library integration
     * Notion is the source of truth. Local storage is cache/settings only.
     * ===================================================================== */
    let naiNotionController = null;

    const NAI_NOTION = Object.freeze({
        version: '2026-03-11',
        tokenKey: 'naiConceptLoader.notion.token',
        prefsKey: 'naiConceptLoader.notion.transferPrefsV1',
        dataSourceKey: 'naiConceptLoader.notion.dataSourceId',
        databaseKey: 'naiConceptLoader.notion.databaseId',
        databaseUrlKey: 'naiConceptLoader.notion.databaseUrl',
        databaseTitleKey: 'naiConceptLoader.notion.databaseTitle',
        rootPageKey: 'naiConceptLoader.notion.rootPageId',
        cacheKey: 'naiConceptLoader.notion.cacheV1',
        cacheMapKey: 'naiConceptLoader.notion.cacheByDataSourceV2',
        archiveListKey: 'naiConceptLoader.notion.archiveListV1',
        archiveListUpdatedKey: 'naiConceptLoader.notion.archiveListUpdatedV1',
        allDatabaseListKey: 'naiConceptLoader.notion.allDatabaseListV1',
        allDatabaseListUpdatedKey: 'naiConceptLoader.notion.allDatabaseListUpdatedV1',
        selectedDataSourcesKey: 'naiConceptLoader.notion.selectedDataSourcesV1',
        personalBaseModeKey: 'naiConceptLoader.notion.personalBaseModeV1',
        referencePresetMapKey: 'naiConceptLoader.notion.preciseReferencePresetsV1',
        activeReferenceKey: 'naiConceptLoader.notion.activePreciseReferenceV1',
        favoriteMapKey: 'naiConceptLoader.notion.favoriteItemsV1',
        libraryModeKey: 'naiConceptLoader.libraryModeV1',
        externalSourcesKey: 'naiConceptLoader.externalNotionSourcesV1',
        wrapperId: 'nai-notion-button-wrapper-v105',
        thumbDb: 'naiConceptLoader.notionThumbsV1',
        thumbStore: 'thumbs'
    });

    const LOGO_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAYAAADimHc4AAATCElEQVR42u1dbWxUVZ//nXPuvL92KLQwrJBNBLeABjGP6JaoIQREXQVTXaL7EgMFt9msMUSBBKGrCawkqKDSD/iB5DE1oKx2nwjK88EN7j6gsIrIrlC1VSqabp1OO3M7b/eesx/2nuvtMDOdt7ZT4CQnM51O5p77+///v//LOfccgvFpJOs9yfG5bMLovJwLCSHIbbfd5o7FYt5YLOZPp9MBACFd10Oc83rOeb0Qoh7ANCFEPed8GoA6AEEAHs65jRACQogK4CfG2J8URekcGRn5yLiEAkA3xjiuQI31nXyv2UCKcgfb0tJi/+yzz9yapnkTiYQ/k8kEAAQ55yHOeUgIETIADAkh6jjnQQABAD4hhBeAWwjhkGMTojzMCCFgjJ1wuVwvxGKxU8bHtFwlKVUAxLgYDMmXo5V0wYIF7oGBAY8QwpdOpwOapgUJISFd10NCiGlGl6BKjZRgugE4rACWCGY+RShGibhx/4RSKmw2264tW7bsaG9v1wxr0MZTACR70C0tLfbTp097YrGYF4A/k8kEOed1UisJIdOEENM45yEAdUKIOgNIvxDCY2glqwBInseiSA6KMz8nhKDQax7FAedcjlGXgmCM/aff7984ODj4tfGZGA9KIgCwY8cOxePxPKEoyjuMsS8opb2U0l8ppQlCiLD2HLSTr3PjhjQAmayuGV03OreAPup6lFLBGBOMMaEoylWdMSYopaWMK2dnjFn/zgAQlNK4y+X6BwterOoWEAwG58RiscOc898V0FReQAPyaqVV88bSSiHEqF5Os9vtcLvd8Hq98Pv9CAQCqKurQ11dHaZNm4ZQKIRQKASn0wlVVdHb24vPP/8cp0+fhq7rMBwzOOfSGhghBIqiHG1sbPzHy5cvX6mGgzbvvKmpyXvx4sX/0HX9VkPqNB9nFmveEjyLWZfcFEWB2+2Gx+OB3++H3+83gZQgWgGtq6tDIBCA3++H1+uFx+OB0+ks+nrnz5/Hvn37cPDgQfP6mqZJOtQBKIyxKy6Xqy0ej79vsQa9IgE4nc7nksnkvxjg27K/SCk1wSw3snC5XPB4PPB6vQgEAggGgwgGgyaIsktwg8Eg/H4/fD4fPB4P3G53QQ4fIzAYUxEYY+bvnzhxAq2trejt7YWiKNB13eobGCEENpvtjVtuueX5r776Si3XQRPLxb/UdX2RJeTK2xwOx5jmbdXKYDCIQCAAn88Hn88Hl8sFm81WNpD56Kkcx3sVv3IOzjkURUF/fz/a2trw7rvvmgLSdR2WcJQqinLe5/NtHBwc/JOFekvXUsaYmsshUUoFIUSsXLlSdHV1iXPnzone3l7x66+/ikQiISppuq4LTdNEJpO5qmuaJnRdF7quC8652SeqaZpmvt+/f79wOp0CgFAUJZeDzrjd7m1W5iyHIgpGBB9//HHZQOYCcyo0zrkpiLNnz4rFixebmFjw0gFwQoiw2Wx/rK+vv9niF0riy5wCkOHfrFmzxEcffSSEECKdTptgXg8tk8kIIYQYGRkRbW1tucJVLq2BMRbx+Xx/X064KgoJQdLRa6+9Nkrzr5dmpaTDhw+L6dOn58oZNImXw+H4/bx58+otlETKFoDVFwAQTz31lEgmk6O041prVr8j6VPTNPO+u7u7xX333Wdik5V0aoa/+L6urm6lNZgsWwBSstIJLV26VHz33Xc1K4R8AObzVVbHXwq1bt++PZclWB20cLlcL7e0tNhzURLJEkDRyZGmaWhoaMChQ4ewcuVKM3uU+UIlLVcRLvs1V55h7ZU2zjlSqRQSiQRGRkagqipisRhisRiGh4cRiUQQj8fx/fff49VXXwUhJNfYzHDVZrN95vV6nxocHLxgTdzKEoA1JiaE4OWXX8bmzZsBAJqm5QShEIDWeL0aAgSAdDqNRCKBRCIBVVURj8dN8IaHhzE0NIShoSFEo1HzvfxfLBZDPB6HqqoYGRlBIpFAKpUqO5s3KEmhlMYcDsffJRKJf63IAqzZsUyI1q1bh71796KxsbFi8DRNQzKZNLUvHo+bAEqwJGC5AJTgqaqKRCKBZDIpE6jKCmc5rEwIUexvywxauFyuvxoZGflDxQKwaq2u62hoaMD69euxfPlyhMNh2Gw2aJoGVVVHaV2+LsGTAEoNTqfTVbEKSmnB7DiXlVYwJ5FXCIyx/9Z1fUFVBJBNSdablZ+VWz8qleML+YsqgJd3XLneF7hnQQgZMWbwykiZ84nW8AeMMbOeYh2E1L5ywaukNF0KePkAzTXO7DFZ3+dxyleV6pVq3pAQQpZuRw1eViJrCbzsymi5wmWMweFwwOVyweVywev1IpVKoaenp7iIcpxWRRS8oVoCz+l0wul0muVur9cLn89nzj3Iaq8sjVu7/K7b7Ybb7YbT6YTNZoOu6+js7MT69euvYoJCM2JVtW9rbb0aEzO5chGpeXLCxufzmSVyCZycnLG+yrK4x+OBx+MxtdfhcFRN+QghePjhh9HV1XWVfzR8gGfcLIAQUjA0UxQFTqdzFHjZmifBs4Jo1TypsVLzqgneWD6n0HwDIQSapoExhubmZnR1dRVMDJXxAF8IgaVLl2L16tWYOXOmCWAuzXM6nbDb7TUBnjXaqhQDSim8Xu/E+gBpao8//jjeeeedCde8apUhJrJVPQoCgOeeew4AkEqlwBi7ZsGrKQHIJRxutxszZ86EEAJ2u/26BLWk7LzqElUUKIpyA/jJoKCp2Kw+Z6JL3lNSANkgVQKGruuj8pXr1gJkglZoriC7llQpaJxzMMaQTqfR29trlrvlnEF2lVa+qqqKaDSKF198EatXrzaFOGUFUOoNpFIpc4ZqeHgYc+bMgdvtLkkonHNQSvH222+jvb0dPT09Zg2r2PbDDz9UVAapCQEIIcAYQ19fHy5duoTBwUEMDg4iGo0iEokgEokgGo2aky5SQ1VVRTKZhKqqWLt2Ld57772iBSm/9+mnn+LJJ5/Mye25BJld07n77rtNy6waHpV0uWLC7/eL/v5+c2K80GIuIYTYuXOn8Hq9ZV1Trkbo7Oy8aunIWGt8nnjiiZKuZbPZxM033yweeughcfjw4YL3J6/x5ptv5lpNJ4zHoSZPABKoI0eOjFrkVGjdv1z7L5fHyAVjlFIxffp00d/fb65+KGZ9T0dHh1ixYoW49dZbRUNDg7Db7XkFvHDhQtHd3S1SqdSoVRdjCbnmBbBixQpBKRV2u90EGWU+TLFu3bqyl8hEo1HR09Mj7rrrrlHAy99ubm4eNfaxLK0UAdDJ4H7Jm5lMBpxzpNNp6Lpe1sS5rutQFAWdnZ344IMPzKXkxThiyemBQABz585FIBDI6cw1TTO/zxirKOqpCScsb/DIkSPo7+9HJBLB4OAguru7sWXLFmQymUJTejnBJISgra0N99xzD/x+v1mTH0sJpBBlGblQdXM85pUnNQqqr69HfX29+XcsFsP27duRyWTKiul/+uknbN68GQcPHoSmaVAUpWiFsK6YmNK1oFLDUM45MpkMdF1HJBIpW8skFb311ls4ceJE0VR0zRXjSqUiuXylGtwqqWjjxo1QVbUqidI1LYDxKGkwxtDT04OtW7deNRd7QwAT0OR87P79+3Hy5Mmap6IpJYBinaSkndbWViSTyZqmIjqVwB8rtLRSkaIo+Oabb9De3l7TVESnitaHw2E8+uijEEIUVQCTRbc9e/bgzJkzNUtFU8YCEokE9u7di7lz5xYlBEk5uq5jw4YNZpJVa1Q0pQQwa9YsvP7660VTkcwNvvzyS+zatasmqWjKCMBms2FgYAAPPPAA1qxZU3L9/6WXXsLXX39dc1Q05aIgIQT27duHYDBYlCVIykmn09iwYYNZgKsVKppSApD1mtmzZ2P37t1m4lUsFZ06dQqvvPJKTVHRlEzENE3Dxo0bsWzZMjPxKpaKtm/fju7ubvNBkhsCqKB1dHSYq6KLpaJEIoHW1laTziabiqakABhj0DQNTU1N2Lp1a0kOWVEUfPLJJzhw4EBNUNGUtQAJ3tatW7FgwQJomlZ0gkYpxfPPP48ff/xx0oUwZQUgKcdut6Ojo6PoWpGMnGKxGDZt2jTpa1intA+QVNTc3IxNmzaZFFMsFR07dgyHDh0qe/eu614AUgicc+zevRvhcNikmLGaXB337LPP4sqVK+PyJOd1IQAZzQQCAezbt6/oYp2cPYtEImhraytpEcANAeRxyGvXrsXatWtLyg0URcH777+PY8eOYcaMGTcEUI0yRSAQKGnuQC5puXjx4oSXKa4ZAVBKwTlHOBwuqUwhl8b39PTgiy++MD+7IYAKqGjTpk1obm4umoqkBV1364LGMz/o6Ogwnz8uNj+44YSrREWapmHBggUllSlu5AHjQEXbtm1DU1NT0WWKGwKY5DLFpArAWBN/TVmBpmlYtmwZNm7cWLNURC1aMyD90bUkBGuZQpYfalUAZ1HBcVK1nJwFg8GSyhSTIgCHw/G2cc5Ize4xUM6GT9YyxSOPPFJSbjChAli0aNF7lNJulHsAwQRos8/nMzcF0TTNeqpFUZawf//+vI8hTboATp06lbDZbC8YVjBhApBlYAlovpbJZHDy5EkMDQ2BMQZFUYreZkCWKWbPno1du3bVlEO2EiJLJpPvKIpyHL+dDjTulGKcTARFUUztzBYQAKiqilWrVmHevHlYvnw5tm3bhq6uLly+fLkoK5BU9PTTT+Pee+8t+hEm+QDJRAmDhEKhMKX0f/Hb2V/j8qC2tZ0/f1688cYb4sEHH8w+nSLnNax91apVRT+kLXdGv3LligiHwzkfIZXXYYyZzw4vXLiwpPsp9zlhwNha3e12rzJuNoPR54ZVRQASiAsXLog77rhj1ADHOqzNZrMJm81mXu/o0aNFC8D6vTNnzohAIHDVNbMPgrvppptER0eHuQ3+eAsABv3A6XS+AMs++BiHB7Xvv//+sh8MD4fD4sCBA2Wd5GE9F+bOO++86rd9Pp9Yvny5OHjwoBgaGipJ+0sVQC4S1AEoyWTynxVF+Z2maQ8Yn1WNCCWn/vLLL/D7/XC73XA4HPB6veb2lT6fb9R2lXLzVJ/Ph8bGRixevBh+v7+s5EomaLfffjtOnTqFs2fPore3F5lMBg0NDZg/fz5mzZr1GyDj6LRzCcA8UbSxsfFvf/755//SdX0OfjtltGrt2LFjEEKYe3+Wun1lJcDIyIhSiiVLlmDJkiVXBQjj8WR8MQKAATbr6+uL+Hy+v1ZV9STnXJ60WrUAuqGhIWfUU8z2ldWITqznH8hZMDkxQymtKGsWQhT1wHmhK+gAlFgsdsrhcDxDCCn7vMRCg8wG2wquDE+zezW3GZPXs/52peUKeS99fX1lW4BsGgAlkUi8Ybfb70yn038jP6tm2bgWW6FzbLLfZ9+PXOj14YcfmnRWjgVYLYEtWrRoE2Ps64lK0qplWZLL5W4smqbl7PL/2VRkpSPrE/35LJMxhoGBAbS2tuLChQumr8mrhCUkaTwUCv1FNBr9nHPuQtZBBLLe4nQ68e2335pRRClanq1Vk7mdpK7rSCaTSCaT5h512Rv75TqWpb+/H+fOncPAwEDexV6EELXUEzQ4ACUSifyP0+lcn0qlOoUQo6hIlnqTySQuXbqEcDiMVCplpvvlgFcumJlMZtQhQPIIqng8bgKXa2dE6wlK8XjcPEFJCqKcKmyOCJMQQpKmzysjatIcDserqVTqn7L9gYyvm5ubcfz4cXM3w1JaKpUytS4bPCtQ2eBJzZSb+o2MjJhCKHX7m0I+q5hzbAqUzTn+/4z6c7quLy5HAAQAbWlpwdGjR/9d1/W/zE7SpNk1NTVh3bp1mD9/PhwOR86TlOTfEjipddazu0rdTrJS8ApRXhWWrWgAFIfD8XIqlXq+ogpqOByena9ol11PqbSPVR8qtLFfvsLeBHaJT9q4l0hdXd2fleqEcxXtdLfbvTKRSBw3/MGo83Nl5JB9slA1wr3JCKxyvBc5/pfNFgSjFz5EXS7XY6qqnqhaFu10Orcbg0hPsqYV0kBu0UTdoALNKDTm6prxPY4yd5C0bK2ZYoxddDgcr86YMePPs8P/SmI2Ymi9ZrPZ/i2TyTxoDN5Wi9pXboJovE8DSAAYIYSMAIgDiBFChgEMGa9RQsgQISRKCBmilA5TSgcZYz8/88wzP7a3t2vWkL4aAjBvdM6cOf6+vr5PjeP5NDm5g9ynNIk84GaDRyoFz/ibA0hlgRc3QJMADlFKhyilUc551ABviFIas9lsMc656nK51OnTpyfWrFmTsoBZKmNwZE33ViNroQB4fX39zGg0+rau6/dVwttZAGqEkBSApAGgaoAXN8AbluAJIYYMDZRgDiuKEuecq3a7XfX7/SPz5s1LHj9+PFXNGcQCOFoVTuSzVlLFwfAdO3bQPXv2rM9kMk9wzhcIIeqEEJRSqgFQDe0bppTGDJONGq+DhukOCiGilNJhxtiQoijDdrtdJYTEQ6FQYufOnYnHHnusGmUQUoSliRItt6z2f0XfBQ+0ksacAAAAAElFTkSuQmCC';

    const naiNotionState = {
        mode: GM_getValue(NAI_NOTION.libraryModeKey, 'personal') === 'external' ? 'external' : 'personal',
        legacyExternalView: false,
        personalCategory: '',
        personalFavoritesOnly: false,
        externalSourceId: '',
        externalFavoritesOnly: false,
        mountedOverlay: null,
        rendering: false,
        syncing: false,
        lastError: '',
        cache: null
    };

    function naiNotionFavoriteItemKey(item) {
        const baseId = String(item?._notionPageId || item?.id || '');
        if (!baseId) return '';
        if (item?._externalSourceId) {
            return `external:${String(item._externalSourceId)}:${String(item._externalDatabaseId || '')}:${baseId}`;
        }
        return `personal:${baseId}`;
    }

    function naiNotionGetFavoriteMap() {
        const raw = GM_getValue(NAI_NOTION.favoriteMapKey, {});
        return raw && typeof raw === 'object' ? raw : {};
    }

    function naiNotionIsFavorite(item) {
        const key = naiNotionFavoriteItemKey(item);
        if (!key) return false;
        return Boolean(naiNotionGetFavoriteMap()[key]);
    }

    function naiNotionToggleFavorite(item) {
        const key = naiNotionFavoriteItemKey(item);
        if (!key) return false;
        const map = { ...naiNotionGetFavoriteMap() };
        const next = !Boolean(map[key]);
        if (next) map[key] = true;
        else delete map[key];
        GM_setValue(NAI_NOTION.favoriteMapKey, map);
        return next;
    }

    function naiNotionFavoriteIcon() {
        return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
    }

    function naiNotionIsVisible(el) {
        if (!el || !el.isConnected) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }

    function naiNotionButtonMaskImage(button) {
        const icon = button?.querySelector(':scope > div');
        if (!icon) return '';
        const style = getComputedStyle(icon);
        return style.maskImage || style.webkitMaskImage || '';
    }

    function naiNotionHasNamedMaskIcon(button, name) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?:^|/)${escaped}(?:\\.[a-z0-9_-]+)?\\.svg(?:[?#][^"')]*|["')]|$)`, 'i')
            .test(naiNotionButtonMaskImage(button));
    }

    function naiNotionFindLivePinButton() {
        const buttons = document.querySelectorAll('button');
        for (const button of buttons) {
            if (!naiNotionIsVisible(button) || !naiNotionHasNamedMaskIcon(button, 'pin')) continue;
            const wrapper = button.parentElement;
            const toolbar = wrapper?.parentElement;
            if (!wrapper || !toolbar) continue;
            if (wrapper.querySelector(':scope > button') !== button) continue;
            const toolbarButtons = [...toolbar.children]
                .map(child => child.querySelector?.(':scope > button'))
                .filter(Boolean);
            const hasClipboard = toolbarButtons.some(x => naiNotionHasNamedMaskIcon(x, 'clipboard'));
            const hasSave = toolbarButtons.some(x => naiNotionHasNamedMaskIcon(x, 'save'));
            if (!hasClipboard || !hasSave) continue;
            return { button, wrapper, toolbar };
        }
        return null;
    }

    function naiNotionMakeNotionWrapper(pinWrapper) {
        const wrapper = pinWrapper.cloneNode(true);
        wrapper.id = NAI_NOTION.wrapperId;
        Object.assign(wrapper.style, { pointerEvents: 'auto', opacity: '1' });
        const button = wrapper.querySelector(':scope > button');
        if (!button) return null;
        button.replaceChildren();
        button.removeAttribute('disabled');
        button.setAttribute('aria-label', 'Notion에 저장');
        button.title = 'Notion에 저장';
        Object.assign(button.style, { pointerEvents: 'auto', opacity: '1', cursor: 'pointer' });
        const logo = document.createElement('img');
        logo.src = LOGO_DATA_URL;
        logo.alt = '';
        logo.draggable = false;
        Object.assign(logo.style, {
            width: '18px', height: '18px', objectFit: 'contain', display: 'block',
            pointerEvents: 'none', userSelect: 'none'
        });
        button.appendChild(logo);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            naiNotionController?.openSaveFlow?.(button);
        });
        button.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            openModal();
            requestAnimationFrame(() => {
                document.querySelector(`#${MODAL_ID} [data-tab="settings"]`)?.click();
                naiNotionController?.mountArchiveModal?.(document.getElementById(MODAL_ID));
                document.getElementById('nai-notion-token-input')?.focus();
            });
        });
        return wrapper;
    }

    function naiNotionInsertButton() {
        const existing = document.getElementById(NAI_NOTION.wrapperId);
        if (existing && naiNotionIsVisible(existing)) return true;
        existing?.remove();
        const live = naiNotionFindLivePinButton();
        if (!live) return false;
        const { wrapper: pinWrapper, toolbar } = live;
        const notionWrapper = naiNotionMakeNotionWrapper(pinWrapper);
        if (!notionWrapper) return false;
        toolbar.insertBefore(notionWrapper, pinWrapper);
        return true;
    }

    function naiNotionGmRequest(details) {
        return new Promise((resolve, reject) => {
            if (!GM_XHR) {
                reject(new Error('GM_xmlhttpRequest를 사용할 수 없습니다.'));
                return;
            }
            GM_XHR({
                ...details,
                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        resolve(response);
                    } else {
                        const error = new Error(`HTTP ${response.status}`);
                        error.status = response.status;
                        error.responseText = response.responseText || '';
                        error.context = details.context || '';
                        reject(error);
                    }
                },
                onerror: error => {
                    const wrapped = new Error('네트워크 요청에 실패했습니다.');
                    wrapped.cause = error;
                    wrapped.context = details.context || '';
                    reject(wrapped);
                },
                ontimeout: () => {
                    const error = new Error('Notion 요청 시간이 초과되었습니다.');
                    error.context = details.context || '';
                    reject(error);
                }
            });
        });
    }

    async function naiNotionJson(token, method, path, body, context = '') {
        const response = await naiNotionGmRequest({
            method,
            url: `https://api.notion.com${path}`,
            headers: {
                Authorization: `Bearer ${token}`,
                'Notion-Version': NAI_NOTION.version,
                'Content-Type': 'application/json'
            },
            data: body === undefined ? undefined : JSON.stringify(body),
            timeout: 30000,
            context
        });
        if (!response.responseText) return null;
        return JSON.parse(response.responseText);
    }

    function naiNotionHumanizeError(error) {
        let apiMessage = '';
        try {
            apiMessage = JSON.parse(error?.responseText || '')?.message || '';
        } catch (_) {}
        const suffix = apiMessage ? ` · ${apiMessage}` : '';
        if (!GM_getValue(NAI_NOTION.tokenKey, '')) return 'Notion API Token이 없습니다.';
        if (error?.status === 401) return `Notion 인증에 실패했습니다. Token을 확인해주세요.${suffix}`;
        if (error?.status === 403) return `Notion 페이지/DB 접근 권한이 없습니다. Integration 연결을 확인해주세요.${suffix}`;
        if (error?.status === 404) return `연결된 Notion DB 또는 페이지를 찾지 못했습니다.${suffix}`;
        if (error?.status === 429) return `Notion API 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.${suffix}`;
        if (String(error?.context || '').includes('upload')) return `Notion 이미지 업로드에 실패했습니다.${suffix || ` · ${error?.message || ''}`}`;
        if (String(error?.context || '').includes('page-create')) return `Notion 페이지 생성에 실패했습니다.${suffix || ` · ${error?.message || ''}`}`;
        return `${error?.message || 'Notion 요청에 실패했습니다.'}${suffix}`;
    }

    function naiNotionRichText(value) {
        if (value === null || value === undefined) return [];
        const text = String(value);
        if (!text) return [];
        const result = [];
        for (let i = 0; i < text.length; i += 1900) {
            result.push({ type: 'text', text: { content: text.slice(i, i + 1900) } });
        }
        return result;
    }

    function naiNotionPlainRichText(property) {
        const rows = property?.rich_text || property?.title || [];
        return rows.map(row => row?.plain_text ?? row?.text?.content ?? '').join('');
    }

    function naiNotionReadToken() {
        return String(GM_getValue(NAI_NOTION.tokenKey, '') || '').trim();
    }

    function naiNotionSaveToken(token) {
        GM_setValue(NAI_NOTION.tokenKey, String(token || '').trim());
    }

    function naiNotionClearConnection() {
        GM_deleteValue(NAI_NOTION.dataSourceKey);
        GM_deleteValue(NAI_NOTION.databaseKey);
        GM_deleteValue(NAI_NOTION.databaseUrlKey);
        GM_deleteValue(NAI_NOTION.databaseTitleKey);
        GM_deleteValue(NAI_NOTION.rootPageKey);
    }

    function naiNotionGetConnection() {
        return {
            dataSourceId: String(GM_getValue(NAI_NOTION.dataSourceKey, '') || ''),
            databaseId: String(GM_getValue(NAI_NOTION.databaseKey, '') || ''),
            databaseUrl: String(GM_getValue(NAI_NOTION.databaseUrlKey, '') || ''),
            title: String(GM_getValue(NAI_NOTION.databaseTitleKey, '') || ''),
            rootPageId: String(GM_getValue(NAI_NOTION.rootPageKey, '') || '')
        };
    }

    function naiNotionSaveConnection(connection) {
        if (connection.dataSourceId) GM_setValue(NAI_NOTION.dataSourceKey, connection.dataSourceId);
        if (connection.databaseId) GM_setValue(NAI_NOTION.databaseKey, connection.databaseId);
        if (connection.databaseUrl) GM_setValue(NAI_NOTION.databaseUrlKey, connection.databaseUrl);
        if (connection.title) GM_setValue(NAI_NOTION.databaseTitleKey, connection.title);
        if (connection.rootPageId) GM_setValue(NAI_NOTION.rootPageKey, connection.rootPageId);
    }

    function naiNotionGetPrefs() {
        const saved = GM_getValue(NAI_NOTION.prefsKey, {});
        return {
            image: saved?.image !== false,
            basePrompt: saved?.basePrompt !== false,
            negativePrompt: saved?.negativePrompt !== false,
            characterPrompt: saved?.characterPrompt !== false,
            seed: saved?.seed !== false,
            steps: saved?.steps !== false,
            guidance: saved?.guidance !== false,
            guidanceRescale: saved?.guidanceRescale !== false
        };
    }

    function naiNotionSetPrefs(prefs) {
        GM_setValue(NAI_NOTION.prefsKey, { ...naiNotionGetPrefs(), ...(prefs || {}) });
    }

    function naiNotionSchema() {
        return {
            'Name': { title: {} },
            'Image': { files: {} },
            'Base Prompt': { rich_text: {} },
            'Undesired Content': { rich_text: {} },
            'Character Prompt': { rich_text: {} },
            'Character Negative': { rich_text: {} },
            'Character Data': { rich_text: {} },
            'Seed': { rich_text: {} },
            'Steps': { number: { format: 'number' } },
            'Guidance': { number: { format: 'number' } },
            'Prompt Guidance Rescale': { number: { format: 'number' } },
            'Categories': { multi_select: {} },
            'Memo': { rich_text: {} },
            'Source': { url: {} },
            'Width': { number: { format: 'number' } },
            'Height': { number: { format: 'number' } },
            'Created': { created_time: {} },
            'Updated': { last_edited_time: {} }
        };
    }

    async function naiNotionEnsureSchema(token, dataSourceId) {
        const current = await naiNotionJson(token, 'GET', `/v1/data_sources/${dataSourceId}`, undefined, 'db-access');
        const props = current?.properties || {};
        const wanted = naiNotionSchema();
        const missing = {};
        for (const [name, def] of Object.entries(wanted)) {
            if (!Object.prototype.hasOwnProperty.call(props, name)) missing[name] = def;
        }
        if (Object.keys(missing).length) {
            await naiNotionJson(token, 'PATCH', `/v1/data_sources/${dataSourceId}`, { properties: missing }, 'db-schema');
        }
        return { ...props, ...missing };
    }

    async function naiNotionFindRootPage(token) {
        const response = await naiNotionJson(token, 'POST', '/v1/search', {
            query: 'NAI to Notion',
            filter: { property: 'object', value: 'page' },
            page_size: 50
        }, 'root-search');
        for (const page of response?.results || []) {
            const title = Object.values(page?.properties || {})
                .filter(p => p?.type === 'title')
                .map(naiNotionPlainRichText)
                .join(' ')
                .trim();
            if (title === 'NAI to Notion') return page.id;
        }
        return '';
    }

    async function naiNotionEnsureRootPage(token) {
        let rootPageId = String(GM_getValue(NAI_NOTION.rootPageKey, '') || '');
        if (rootPageId) {
            try {
                await naiNotionJson(token, 'GET', `/v1/pages/${rootPageId}`, undefined, 'root-access');
                return rootPageId;
            } catch (_) {
                GM_deleteValue(NAI_NOTION.rootPageKey);
                rootPageId = '';
            }
        }
        rootPageId = await naiNotionFindRootPage(token);
        if (!rootPageId) {
            const page = await naiNotionJson(token, 'POST', '/v1/pages', {
                properties: { title: naiNotionRichText('NAI to Notion') },
                icon: { type: 'emoji', emoji: '🎨' }
            }, 'root-create');
            rootPageId = page?.id || '';
        }
        if (!rootPageId) throw new Error('NAI to Notion 루트 페이지를 만들지 못했습니다.');
        GM_setValue(NAI_NOTION.rootPageKey, rootPageId);
        return rootPageId;
    }

    async function naiNotionGetDataSourceId(token, database) {
        let id = database?.data_sources?.[0]?.id || '';
        if (!id && database?.id) {
            const fresh = await naiNotionJson(token, 'GET', `/v1/databases/${database.id}`, undefined, 'db-access');
            id = fresh?.data_sources?.[0]?.id || '';
        }
        if (!id) throw new Error('Notion Data Source ID를 확인하지 못했습니다.');
        return id;
    }

    async function naiNotionCreateDatabase(token, rootPageId, title = 'NAI Archive') {
        const database = await naiNotionJson(token, 'POST', '/v1/databases', {
            parent: { type: 'page_id', page_id: rootPageId },
            title: naiNotionRichText(title),
            description: naiNotionRichText('NovelAI 이미지와 Prompt를 저장하는 NAI Archive 개인 라이브러리입니다.'),
            is_inline: false,
            icon: { type: 'emoji', emoji: '🖼️' },
            initial_data_source: { properties: naiNotionSchema() }
        }, 'db-create');
        if (!database?.id) throw new Error('NAI Archive 데이터베이스를 만들지 못했습니다.');
        const dataSourceId = await naiNotionGetDataSourceId(token, database);
        return {
            title,
            databaseId: database.id,
            dataSourceId,
            databaseUrl: database.url || '',
            rootPageId
        };
    }

    function naiNotionArchiveListCache(rootPageId = '') {
        const raw = GM_getValue(NAI_NOTION.archiveListKey, []);
        const rows = Array.isArray(raw) ? raw : [];
        const root = String(rootPageId || '');
        return rows
            .filter(row => row && row.dataSourceId && (!root || !row.rootPageId || row.rootPageId === root))
            .map(row => ({
                title: String(row.title || 'NAI Archive'),
                databaseId: String(row.databaseId || ''),
                dataSourceId: String(row.dataSourceId || ''),
                databaseUrl: String(row.databaseUrl || ''),
                rootPageId: String(row.rootPageId || root || '')
            }));
    }

    function naiNotionSaveArchiveListCache(archives, rootPageId = '') {
        const root = String(rootPageId || '');
        const unique = new Map();
        for (const row of Array.isArray(archives) ? archives : []) {
            if (!row?.dataSourceId) continue;
            unique.set(String(row.dataSourceId), {
                title: String(row.title || 'NAI Archive'),
                databaseId: String(row.databaseId || ''),
                dataSourceId: String(row.dataSourceId || ''),
                databaseUrl: String(row.databaseUrl || ''),
                rootPageId: String(row.rootPageId || root || '')
            });
        }
        const current = naiNotionGetConnection();
        if (current.dataSourceId && !unique.has(current.dataSourceId)) {
            unique.set(current.dataSourceId, { ...current, rootPageId: current.rootPageId || root || '' });
        }
        const rows = [...unique.values()];
        GM_setValue(NAI_NOTION.archiveListKey, rows);
        GM_setValue(NAI_NOTION.archiveListUpdatedKey, Date.now());
        return rows;
    }

    function naiNotionNormalizeDatabaseEntry(row) {
        if (!row || !row.dataSourceId) return null;
        return {
            title: String(row.title || 'Notion DB'),
            databaseId: String(row.databaseId || ''),
            dataSourceId: String(row.dataSourceId || ''),
            databaseUrl: String(row.databaseUrl || ''),
            rootPageId: String(row.rootPageId || ''),
            source: String(row.source || 'account')
        };
    }

    function naiNotionAllDatabaseListCache() {
        const raw = GM_getValue(NAI_NOTION.allDatabaseListKey, []);
        const rows = Array.isArray(raw) ? raw : [];
        const unique = new Map();
        for (const row of rows) {
            const normalized = naiNotionNormalizeDatabaseEntry(row);
            if (normalized) unique.set(normalized.dataSourceId, normalized);
        }

        // Upgrade compatibility: databases already known to older versions are
        // included immediately, even before the first account-wide refresh.
        for (const row of naiNotionArchiveListCache('')) {
            const normalized = naiNotionNormalizeDatabaseEntry(row);
            if (normalized && !unique.has(normalized.dataSourceId)) {
                unique.set(normalized.dataSourceId, normalized);
            }
        }
        const current = naiNotionGetConnection();
        const currentNormalized = naiNotionNormalizeDatabaseEntry(current);
        if (currentNormalized && !unique.has(currentNormalized.dataSourceId)) {
            unique.set(currentNormalized.dataSourceId, currentNormalized);
        }
        return [...unique.values()];
    }

    function naiNotionSaveAllDatabaseListCache(rows) {
        const unique = new Map();
        for (const row of Array.isArray(rows) ? rows : []) {
            const normalized = naiNotionNormalizeDatabaseEntry(row);
            if (normalized) unique.set(normalized.dataSourceId, normalized);
        }
        const current = naiNotionNormalizeDatabaseEntry(naiNotionGetConnection());
        if (current && !unique.has(current.dataSourceId)) {
            unique.set(current.dataSourceId, current);
        }
        const saved = [...unique.values()].sort((a, b) =>
            String(a.title || '').localeCompare(String(b.title || ''), 'ko')
        );
        GM_setValue(NAI_NOTION.allDatabaseListKey, saved);
        GM_setValue(NAI_NOTION.allDatabaseListUpdatedKey, Date.now());
        return saved;
    }

    function naiNotionSelectedDataSourceIds() {
        const raw = GM_getValue(NAI_NOTION.selectedDataSourcesKey, null);
        if (Array.isArray(raw)) {
            return [...new Set(raw.map(String).filter(Boolean))];
        }

        // First run after upgrade: preserve what the user was already using,
        // rather than suddenly showing every database on the account.
        const boot = new Set(
            naiNotionArchiveListCache('')
                .map(row => String(row.dataSourceId || ''))
                .filter(Boolean)
        );
        const current = naiNotionGetConnection();
        if (current.dataSourceId) boot.add(String(current.dataSourceId));
        return [...boot];
    }

    function naiNotionSaveSelectedDataSourceIds(ids) {
        const safe = [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];
        GM_setValue(NAI_NOTION.selectedDataSourcesKey, safe);
        return safe;
    }

    function naiNotionVisiblePersonalArchives() {
        const selected = new Set(naiNotionSelectedDataSourceIds());
        if (!selected.size) return [];

        const unique = new Map();
        for (const row of naiNotionAllDatabaseListCache()) {
            if (selected.has(String(row.dataSourceId || ''))) {
                unique.set(String(row.dataSourceId), row);
            }
        }

        // Keep a selected legacy/current DB visible even if the global list has
        // not been refreshed yet.
        for (const row of naiNotionArchiveListCache('')) {
            const id = String(row?.dataSourceId || '');
            if (id && selected.has(id) && !unique.has(id)) unique.set(id, row);
        }
        const current = naiNotionGetConnection();
        if (
            current.dataSourceId &&
            selected.has(String(current.dataSourceId)) &&
            !unique.has(String(current.dataSourceId))
        ) {
            unique.set(String(current.dataSourceId), current);
        }

        return [...unique.values()].sort((a, b) =>
            String(a.title || '').localeCompare(String(b.title || ''), 'ko')
        );
    }

    function naiNotionObjectTitle(obj) {
        const candidates = [obj?.title, obj?.name];
        for (const candidate of candidates) {
            if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
            if (Array.isArray(candidate)) {
                const value = candidate
                    .map(row =>
                        row?.plain_text ??
                        row?.text?.content ??
                        (Array.isArray(row) ? row?.[0] : '') ??
                        ''
                    )
                    .join('')
                    .trim();
                if (value) return value;
            }
        }
        return '';
    }

    async function naiNotionSearchAllObjects(token, filterValue = '') {
        const rows = [];
        let cursor = '';
        do {
            const body = { page_size: 100 };
            if (cursor) body.start_cursor = cursor;
            if (filterValue) {
                body.filter = { property: 'object', value: filterValue };
            }
            const response = await naiNotionJson(
                token,
                'POST',
                '/v1/search',
                body,
                'account-db-search'
            );
            rows.push(...(response?.results || []));
            cursor = response?.has_more ? (response.next_cursor || '') : '';
        } while (cursor);
        return rows;
    }

    async function naiNotionDiscoverAllDatabases(token) {
        let results = [];
        try {
            // Current Notion API versions expose database contents as
            // data_source objects in Search.
            results = await naiNotionSearchAllObjects(token, 'data_source');
        } catch (error) {
            if (error?.status !== 400) throw error;
            try {
                // Compatibility with older/alternate Search behavior.
                results = await naiNotionSearchAllObjects(token, 'database');
            } catch (fallbackError) {
                if (fallbackError?.status !== 400) throw fallbackError;
                results = await naiNotionSearchAllObjects(token, '');
            }
        }

        const entries = [];
        const seen = new Set();
        const databaseMeta = new Map();

        for (const result of results) {
            if (!result || typeof result !== 'object') continue;

            if (result.object === 'database') {
                const databaseId = String(result.id || '');
                const databaseTitle = naiNotionObjectTitle(result) || 'Notion DB';
                const databaseUrl = String(result.url || '');
                databaseMeta.set(databaseId, {
                    title: databaseTitle,
                    databaseUrl
                });

                const sources = Array.isArray(result.data_sources)
                    ? result.data_sources
                    : [];
                for (const source of sources) {
                    const dataSourceId = String(source?.id || '');
                    if (!dataSourceId || seen.has(dataSourceId)) continue;
                    seen.add(dataSourceId);
                    const sourceTitle = naiNotionObjectTitle(source);
                    entries.push({
                        title:
                            sources.length > 1 && sourceTitle && sourceTitle !== databaseTitle
                                ? `${databaseTitle} · ${sourceTitle}`
                                : databaseTitle,
                        databaseId,
                        dataSourceId,
                        databaseUrl,
                        rootPageId: '',
                        source: 'account'
                    });
                }
                continue;
            }

            if (result.object === 'data_source') {
                const dataSourceId = String(result.id || '');
                if (!dataSourceId || seen.has(dataSourceId)) continue;
                seen.add(dataSourceId);

                const databaseId = String(
                    result?.parent?.database_id ||
                    result?.database_parent?.database_id ||
                    ''
                );
                const title =
                    naiNotionObjectTitle(result) ||
                    (databaseId ? `Notion DB ${databaseId.slice(0, 8)}…` : `Data Source ${dataSourceId.slice(0, 8)}…`);
                entries.push({
                    title,
                    databaseId,
                    dataSourceId,
                    databaseUrl: String(result.url || ''),
                    rootPageId: '',
                    source: 'account'
                });
            }
        }

        // If Search returned database objects without embedded data_sources,
        // resolve only those databases. This path is intentionally sequential
        // to stay friendly to Notion's rate limit.
        for (const result of results) {
            if (result?.object !== 'database' || !result?.id) continue;
            const databaseId = String(result.id);
            if (entries.some(row => row.databaseId === databaseId)) continue;
            try {
                const db = await naiNotionJson(
                    token,
                    'GET',
                    `/v1/databases/${databaseId}`,
                    undefined,
                    'account-db-resolve'
                );
                const sources = Array.isArray(db?.data_sources) ? db.data_sources : [];
                const databaseTitle =
                    naiNotionObjectTitle(db) ||
                    naiNotionObjectTitle(result) ||
                    'Notion DB';
                for (const source of sources) {
                    const dataSourceId = String(source?.id || '');
                    if (!dataSourceId || seen.has(dataSourceId)) continue;
                    seen.add(dataSourceId);
                    entries.push({
                        title: databaseTitle,
                        databaseId,
                        dataSourceId,
                        databaseUrl: String(db?.url || result?.url || ''),
                        rootPageId: '',
                        source: 'account'
                    });
                }
            } catch (error) {
                console.warn(`[${APP_NAME}] Notion account DB resolve skipped`, error);
            }
        }

        // Preserve older known NAI databases that are still accessible but
        // happened not to appear in the current Search response.
        for (const row of naiNotionArchiveListCache('')) {
            const normalized = naiNotionNormalizeDatabaseEntry(row);
            if (normalized && !seen.has(normalized.dataSourceId)) {
                entries.push(normalized);
                seen.add(normalized.dataSourceId);
            }
        }

        return naiNotionSaveAllDatabaseListCache(entries);
    }

    function naiNotionClearActiveConnectionOnly() {
        GM_deleteValue(NAI_NOTION.dataSourceKey);
        GM_deleteValue(NAI_NOTION.databaseKey);
        GM_deleteValue(NAI_NOTION.databaseUrlKey);
        GM_deleteValue(NAI_NOTION.databaseTitleKey);
        naiNotionState.cache = null;
    }

    function naiNotionDatabaseManagerModal(token, { refreshOnOpen = false } = {}) {
        return new Promise(resolve => {
            let allRows = naiNotionAllDatabaseListCache();
            let selected = new Set(naiNotionSelectedDataSourceIds());
            const current = naiNotionGetConnection();

            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-database-manager';
            overlay.innerHTML = `
                <div class="nai-loader-modal nai-notion-db-manager-modal">
                    <div class="nai-loader-header">
                        <div class="nai-loader-title"><span>표시할 Notion DB</span></div>
                        <button type="button" class="nai-loader-close" data-db-close>×</button>
                    </div>
                    <div class="nai-loader-content"><div class="nai-loader-panel active">
                        <div class="nai-loader-row nai-notion-db-manager-toolbar">
                            <input class="nai-loader-input nai-loader-grow" data-db-search placeholder="DB 이름 검색">
                            <button type="button" class="nai-loader-action" data-db-refresh>목록 새로고침</button>
                        </div>
                        <div class="nai-loader-muted" style="margin:8px 0 10px;">
                            Notion Integration/PAT가 접근 가능한 DB만 표시됩니다. 체크한 DB만 내 라이브러리 저장소 목록에 나타납니다.
                        </div>
                        <div class="nai-notion-db-manager-list" data-db-list></div>
                        <div class="nai-loader-row" style="margin-top:10px;justify-content:space-between;">
                            <div class="nai-loader-row">
                                <button type="button" class="nai-loader-action" data-db-all>전체 선택</button>
                                <button type="button" class="nai-loader-action" data-db-none>선택 해제</button>
                            </div>
                            <div class="nai-loader-row">
                                <span class="nai-notion-inline-status" data-db-status></span>
                                <button type="button" class="nai-loader-action" data-db-cancel>취소</button>
                                <button type="button" class="nai-loader-action primary" data-db-apply>표시 적용</button>
                            </div>
                        </div>
                    </div></div>
                </div>`;

            const list = overlay.querySelector('[data-db-list]');
            const search = overlay.querySelector('[data-db-search]');
            const status = overlay.querySelector('[data-db-status]');
            const refreshButton = overlay.querySelector('[data-db-refresh]');

            const render = () => {
                const q = String(search.value || '').trim().toLowerCase();
                const visible = allRows.filter(row =>
                    !q ||
                    String(row.title || '').toLowerCase().includes(q) ||
                    String(row.databaseUrl || '').toLowerCase().includes(q)
                );

                if (!allRows.length) {
                    list.innerHTML = '<div class="nai-loader-muted" style="padding:16px 4px;">아직 불러온 DB가 없습니다. “목록 새로고침”을 눌러주세요.</div>';
                    return;
                }
                if (!visible.length) {
                    list.innerHTML = '<div class="nai-loader-muted" style="padding:16px 4px;">검색 결과가 없습니다.</div>';
                    return;
                }

                list.innerHTML = visible.map(row => {
                    const id = String(row.dataSourceId);
                    const isCurrent = id === String(current.dataSourceId || '');
                    return `
                        <label class="nai-notion-db-choice">
                            <input type="checkbox" data-db-id="${escapeHtml(id)}" ${selected.has(id) ? 'checked' : ''}>
                            <span class="nai-notion-db-choice-main">
                                <strong>${escapeHtml(row.title || 'Notion DB')}</strong>
                                <small>${escapeHtml(row.databaseUrl || `Data Source ${id.slice(0, 8)}…`)}</small>
                            </span>
                            ${isCurrent ? '<span class="nai-notion-db-current">사용 중</span>' : ''}
                        </label>`;
                }).join('');
            };

            const refresh = async () => {
                try {
                    refreshButton.disabled = true;
                    status.textContent = 'Notion DB 목록 불러오는 중…';
                    allRows = await naiNotionDiscoverAllDatabases(token);

                    // The currently active DB remains selected on the first
                    // discovery unless the user explicitly unchecks it.
                    if (
                        current.dataSourceId &&
                        GM_getValue(NAI_NOTION.selectedDataSourcesKey, null) === null
                    ) {
                        selected.add(String(current.dataSourceId));
                    }

                    render();
                    status.textContent = `접근 가능한 DB ${allRows.length}개`;
                } catch (error) {
                    status.textContent = naiNotionHumanizeError(error);
                } finally {
                    refreshButton.disabled = false;
                }
            };

            const finish = value => {
                overlay.remove();
                resolve(value);
            };

            list.addEventListener('change', event => {
                const input = event.target.closest('[data-db-id]');
                if (!input) return;
                const id = String(input.dataset.dbId || '');
                if (input.checked) selected.add(id);
                else selected.delete(id);
            });
            search.addEventListener('input', render);
            overlay.querySelector('[data-db-all]').onclick = () => {
                selected = new Set(allRows.map(row => String(row.dataSourceId)));
                render();
            };
            overlay.querySelector('[data-db-none]').onclick = () => {
                selected.clear();
                render();
            };
            refreshButton.onclick = refresh;
            overlay.querySelector('[data-db-close]').onclick = () => finish(null);
            overlay.querySelector('[data-db-cancel]').onclick = () => finish(null);
            overlay.addEventListener('mousedown', event => {
                if (event.target === overlay) finish(null);
            });

            overlay.querySelector('[data-db-apply]').onclick = () => {
                const ids = naiNotionSaveSelectedDataSourceIds([...selected]);
                const selectedRows = allRows.filter(row => ids.includes(String(row.dataSourceId)));
                const currentId = String(naiNotionGetConnection().dataSourceId || '');

                if (currentId && !ids.includes(currentId)) {
                    const next = selectedRows[0] || null;
                    if (next) {
                        naiNotionSaveConnection(next);
                        naiNotionState.cache = naiNotionLoadCache(next.dataSourceId);
                    } else {
                        naiNotionClearActiveConnectionOnly();
                    }
                } else if (!currentId && selectedRows[0]) {
                    naiNotionSaveConnection(selectedRows[0]);
                    naiNotionState.cache = naiNotionLoadCache(selectedRows[0].dataSourceId);
                }

                naiNotionState.personalCategory = '';
                naiNotionController?.renderLibraryPanel?.();
                finish({
                    total: allRows.length,
                    selected: selectedRows.length,
                    rows: selectedRows
                });
            };

            document.body.appendChild(overlay);
            render();
            if (refreshOnOpen) {
                setTimeout(() => refresh(), 0);
            }
        });
    }

    async function naiNotionListArchives(token, rootPageId) {
        const databases = [];
        let cursor = '';
        do {
            const q = new URLSearchParams({ page_size: '100' });
            if (cursor) q.set('start_cursor', cursor);
            const response = await naiNotionJson(token, 'GET', `/v1/blocks/${rootPageId}/children?${q}`, undefined, 'db-list');
            for (const block of response?.results || []) {
                if (block?.type !== 'child_database' || !block?.id) continue;
                try {
                    const db = await naiNotionJson(token, 'GET', `/v1/databases/${block.id}`, undefined, 'db-access');
                    const dataSourceId = await naiNotionGetDataSourceId(token, db);
                    const ds = await naiNotionJson(token, 'GET', `/v1/data_sources/${dataSourceId}`, undefined, 'db-access');
                    const props = ds?.properties || {};
                    if (!props.Name || !props['Base Prompt']) continue;
                    databases.push({
                        title: block.child_database?.title || 'NAI Archive',
                        databaseId: db.id,
                        dataSourceId,
                        databaseUrl: db.url || '',
                        rootPageId
                    });
                } catch (error) {
                    console.warn(`[${APP_NAME}] Notion DB scan skipped`, error);
                }
            }
            cursor = response?.has_more ? (response.next_cursor || '') : '';
        } while (cursor);
        naiNotionSaveArchiveListCache(databases, rootPageId);
        return databases;
    }

    function naiNotionChoiceModal(archives, rootPageId, token) {
        return new Promise(resolve => {
            let currentArchives = Array.isArray(archives) ? [...archives] : [];
            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-choice-modal';
            overlay.innerHTML = `
                <div class="nai-loader-modal nai-notion-small-modal">
                    <div class="nai-loader-header">
                        <div class="nai-loader-title"><span>Notion 저장소 선택</span></div>
                        <button type="button" class="nai-loader-close" data-nn-close>×</button>
                    </div>
                    <div class="nai-loader-content"><div class="nai-loader-panel active">
                        <div class="nai-loader-row" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
                            <div class="nai-loader-muted">체크해서 표시한 DB만 이 목록에 나타납니다. 저장소 전환은 로컬 캐시로 즉시 처리됩니다.</div>
                            <button type="button" class="nai-loader-action" data-nn-reload-list>표시 목록 관리</button>
                        </div>
                        <div class="nai-notion-choice-list" data-nn-choice-list></div>
                        <div class="nai-loader-divider"></div>
                        <div class="nai-loader-row">
                            <input class="nai-loader-input nai-loader-grow" data-nn-new-name placeholder="새 저장소 이름 (예: 작업용)">
                            <button type="button" class="nai-loader-action primary" data-nn-create>새 저장소</button>
                        </div>
                        <div class="nai-loader-status" data-nn-status></div>
                    </div></div>
                </div>`;
            const list = overlay.querySelector('[data-nn-choice-list]');
            const status = overlay.querySelector('[data-nn-status]');
            const renderChoices = () => {
                if (!currentArchives.length) {
                    list.innerHTML = '<div class="nai-loader-muted" style="padding:10px 2px;">표시하도록 선택한 DB가 없습니다. “표시 목록 관리”에서 DB를 체크해주세요.</div>';
                    return;
                }
                list.innerHTML = currentArchives.map((a, i) => `<button type="button" class="nai-notion-choice" data-nn-archive="${i}"><strong>${escapeHtml(a.title)}</strong><span>${escapeHtml(a.databaseUrl || '')}</span></button>`).join('');
            };
            const finish = value => { overlay.remove(); resolve(value); };
            renderChoices();
            overlay.querySelector('[data-nn-close]').onclick = () => finish(null);
            overlay.addEventListener('mousedown', e => { if (e.target === overlay) finish(null); });
            list.addEventListener('click', e => {
                const button = e.target.closest('[data-nn-archive]');
                if (!button) return;
                finish(currentArchives[Number(button.dataset.nnArchive)] || null);
            });
            overlay.querySelector('[data-nn-reload-list]').addEventListener('click', async () => {
                const button = overlay.querySelector('[data-nn-reload-list]');
                try {
                    button.disabled = true;
                    status.textContent = '표시할 DB 목록을 여는 중…';
                    await naiNotionDatabaseManagerModal(token, { refreshOnOpen: false });
                    currentArchives = naiNotionVisiblePersonalArchives();
                    renderChoices();
                    status.textContent = `표시 중인 DB ${currentArchives.length}개`;
                } catch (error) {
                    status.textContent = naiNotionHumanizeError(error);
                } finally {
                    button.disabled = false;
                }
            });
            overlay.querySelector('[data-nn-create]').addEventListener('click', async () => {
                const raw = overlay.querySelector('[data-nn-new-name]').value.trim();
                const title = raw ? (/^NAI Archive/i.test(raw) ? raw : `NAI Archive - ${raw}`) : 'NAI Archive';
                try {
                    status.textContent = '새 저장소를 만드는 중…';
                    const targetRootPageId = rootPageId || await naiNotionEnsureRootPage(token);
                    const archive = await naiNotionCreateDatabase(token, targetRootPageId, title);
                    naiNotionSaveArchiveListCache([...currentArchives, archive], rootPageId);
                    naiNotionSaveAllDatabaseListCache([
                        ...naiNotionAllDatabaseListCache(),
                        archive
                    ]);
                    naiNotionSaveSelectedDataSourceIds([
                        ...naiNotionSelectedDataSourceIds(),
                        archive.dataSourceId
                    ]);
                    finish(archive);
                } catch (error) {
                    status.textContent = naiNotionHumanizeError(error);
                }
            });
            document.body.appendChild(overlay);
        });
    }

    async function naiNotionEnsureArchive(token, interactive = true) {
        const saved = naiNotionGetConnection();
        if (saved.dataSourceId) {
            try {
                await naiNotionEnsureSchema(token, saved.dataSourceId);
                if (!saved.title && saved.databaseId) {
                    try {
                        const db = await naiNotionJson(token, 'GET', `/v1/databases/${saved.databaseId}`, undefined, 'db-access');
                        const title = (db?.title || []).map(row => row?.plain_text ?? row?.text?.content ?? '').join('').trim();
                        if (title) {
                            const resolved = { ...saved, title };
                            naiNotionSaveConnection(resolved);
                            return resolved;
                        }
                    } catch (_) {}
                }
                return saved;
            } catch (error) {
                if (![401, 403].includes(error?.status)) naiNotionClearConnection();
                else throw error;
            }
        }
        const rootPageId = await naiNotionEnsureRootPage(token);
        const archives = await naiNotionListArchives(token, rootPageId);
        let chosen = null;
        if (archives.length === 1) chosen = archives[0];
        else if (archives.length > 1 && interactive) chosen = await naiNotionChoiceModal(archives, rootPageId, token);
        else if (archives.length > 1) chosen = archives[0];
        if (!chosen && !archives.length) chosen = await naiNotionCreateDatabase(token, rootPageId, 'NAI Archive');
        if (!chosen) throw new Error('Notion 저장소 선택이 취소되었습니다.');
        naiNotionSaveConnection(chosen);
        await naiNotionEnsureSchema(token, chosen.dataSourceId);
        return chosen;
    }

    function naiNotionTokenModal() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-token-modal';
            overlay.innerHTML = `
              <div class="nai-loader-modal nai-notion-small-modal">
                <div class="nai-loader-header"><div class="nai-loader-title"><span>Notion 연결</span></div><button type="button" class="nai-loader-close" data-nn-close>×</button></div>
                <div class="nai-loader-content"><div class="nai-loader-panel active">
                  <div class="nai-loader-field"><label class="nai-loader-label">Notion API Token</label><input class="nai-loader-input" type="password" autocomplete="off" data-nn-token placeholder="ntn_... / secret_..."></div>
                  <div class="nai-loader-muted">이 토큰은 현재 브라우저의 Tampermonkey 저장소에만 보관됩니다. GitHub 소스나 공유 데이터에는 포함되지 않습니다.</div>
                  <div class="nai-edit-footer-actions" style="margin-top:16px;"><button type="button" class="nai-loader-action" data-nn-close2>취소</button><button type="button" class="nai-loader-action primary" data-nn-save>연결</button></div>
                  <div class="nai-loader-status" data-nn-status></div>
                </div></div>
              </div>`;
            const input = overlay.querySelector('[data-nn-token]');
            const finish = value => { overlay.remove(); resolve(value); };
            overlay.querySelector('[data-nn-close]').onclick = () => finish('');
            overlay.querySelector('[data-nn-close2]').onclick = () => finish('');
            overlay.querySelector('[data-nn-save]').onclick = () => finish(input.value.trim());
            input.addEventListener('keydown', e => { if (e.key === 'Enter') overlay.querySelector('[data-nn-save]').click(); if (e.key === 'Escape') finish(''); });
            document.body.appendChild(overlay);
            requestAnimationFrame(() => input.focus());
        });
    }

    async function naiNotionGetTokenInteractive() {
        let token = naiNotionReadToken();
        if (token) return token;
        token = await naiNotionTokenModal();
        if (!token) return '';
        naiNotionSaveToken(token);
        return token;
    }

    function naiNotionDecodeLatin1(bytes) {
        return new TextDecoder('latin1').decode(bytes);
    }

    function naiNotionReadPngTextChunks(arrayBuffer) {
        const bytes = new Uint8Array(arrayBuffer);
        const view = new DataView(arrayBuffer);
        if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71 || bytes[4] !== 13 || bytes[5] !== 10 || bytes[6] !== 26 || bytes[7] !== 10) {
            throw new Error('현재 이미지가 PNG 형식이 아닙니다.');
        }
        let pos = 8;
        const chunks = [];
        while (pos + 12 <= bytes.length) {
            const length = view.getUint32(pos);
            const type = String.fromCharCode(...bytes.slice(pos + 4, pos + 8));
            const start = pos + 8;
            const end = start + length;
            if (end + 4 > bytes.length) break;
            if (type === 'tEXt') {
                const data = bytes.slice(start, end);
                const zero = data.indexOf(0);
                if (zero !== -1) chunks.push({ type, key: naiNotionDecodeLatin1(data.slice(0, zero)), value: naiNotionDecodeLatin1(data.slice(zero + 1)) });
            }
            pos = end + 4;
            if (type === 'IEND') break;
        }
        return chunks;
    }

    function naiNotionFindCurrentImageElement() {
        const candidates = [...document.querySelectorAll('img.image-grid-image')]
            .filter(naiNotionIsVisible)
            .map(img => ({
                img,
                area: img.getBoundingClientRect().width * img.getBoundingClientRect().height
            }))
            .sort((a, b) => b.area - a.area);
        return candidates[0]?.img || null;
    }

    async function naiNotionGetCurrentImage() {
        const img = naiNotionFindCurrentImageElement();
        if (!img) throw new Error('현재 화면에서 NAI 이미지를 찾지 못했습니다.');
        const src = img.currentSrc || img.src;
        const response = await fetch(src);
        if (!response.ok) throw new Error(`이미지를 읽지 못했습니다. (${response.status})`);
        const blob = await response.blob();
        const buffer = await blob.arrayBuffer();
        const chunks = naiNotionReadPngTextChunks(buffer);
        const comment = chunks.find(x => x.key === 'Comment')?.value;
        let metadata = {};
        if (comment) {
            try { metadata = JSON.parse(comment); } catch (_) { throw new Error('NovelAI PNG Comment 메타데이터를 해석하지 못했습니다.'); }
        }
        return { blob, metadata, chunks, img, src };
    }

    function naiNotionMetadataFields(meta) {
        return {
            width: Number(meta?.width) || null,
            height: Number(meta?.height) || null,
            steps: Number(meta?.steps) || null,
            guidance: Number(meta?.scale) || null,
            guidanceRescale: meta?.cfg_rescale === undefined || meta?.cfg_rescale === null ? null : Number(meta.cfg_rescale),
            seed: meta?.seed === undefined || meta?.seed === null ? '' : String(meta.seed)
        };
    }

    function naiNotionEditorText(editor) {
        if (!editor) return '';
        const paragraphs = [...editor.querySelectorAll(':scope > p')];
        const text = paragraphs.length ? paragraphs.map(p => promptText(p.textContent)).join('\n') : promptText(editor.textContent);
        return String(text || '').trim();
    }

    function naiNotionCharacterLooksActive(container) {
        if (!container || !container.isConnected) return false;
        if (container.matches('[aria-disabled="true"], [data-disabled="true"], [data-enabled="false"]')) return false;
        const owner = container.closest('[data-character-prompt], .character-prompt-input') || container;
        const checkbox = owner.querySelector('input[type="checkbox"]');
        if (checkbox && checkbox.checked === false) return false;
        const toggles = [...owner.querySelectorAll('button[aria-label], button[title], button[aria-pressed], button[data-state]')];
        for (const button of toggles) {
            const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''}`.toLowerCase();
            const relevant = /enable|disable|active|활성|사용/.test(label);
            if (!relevant) continue;
            if (button.getAttribute('aria-pressed') === 'false' || button.dataset.state === 'off') return false;
        }
        return true;
    }

    async function naiNotionReadCurrentPromptState() {
        const result = { basePrompt: '', negativePrompt: '', characters: [] };
        const base = await activateMainPrompt('base');
        if (base.ok) result.basePrompt = naiNotionEditorText(base.editor);
        const negative = await activateMainPrompt('negative');
        if (negative.ok) result.negativePrompt = naiNotionEditorText(negative.editor);
        const count = getCharacterPromptCount();
        for (let index = 1; index <= count; index++) {
            const container = findCharacterPromptContainer(index);
            if (!container || !naiNotionCharacterLooksActive(container)) continue;
            const promptTab = await activateCharacterPrompt(index, 'prompt');
            const negativeTab = await activateCharacterPrompt(index, 'negative');
            const prompt = promptTab.ok ? naiNotionEditorText(promptTab.editor) : '';
            const charNegative = negativeTab.ok ? naiNotionEditorText(negativeTab.editor) : '';
            if (!prompt && !charNegative) continue;
            result.characters.push({ name: `Character ${result.characters.length + 1}`, prompt, negativePrompt: charNegative });
            await activateCharacterPrompt(index, 'prompt');
        }
        await activateMainPrompt('base');
        return result;
    }

    function naiNotionFormatCharacters(characters, kind) {
        return (characters || []).map((character, index) => {
            const value = kind === 'negative' ? character.negativePrompt : character.prompt;
            if (!value) return '';
            return `[${character.name || `Character ${index + 1}`}] ${value}`;
        }).filter(Boolean).join('\n\n');
    }

    async function naiNotionUploadImage(token, blob, fields) {
        const filename = `nai_${fields.seed || Date.now()}_${fields.width || 'x'}x${fields.height || 'x'}.png`;
        const created = await naiNotionJson(token, 'POST', '/v1/file_uploads', {
            mode: 'single_part', filename, content_type: 'image/png'
        }, 'upload-create');
        if (!created?.id) throw new Error('Notion File Upload를 생성하지 못했습니다.');
        const form = new FormData();
        form.append('file', blob, filename);
        await naiNotionGmRequest({
            method: 'POST',
            url: `https://api.notion.com/v1/file_uploads/${created.id}/send`,
            headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NAI_NOTION.version },
            data: form,
            timeout: 60000,
            context: 'upload-send'
        });
        return { id: created.id, filename };
    }

    function naiNotionPageProperties(draft, prefs, upload = null) {
        const properties = { Name: { title: naiNotionRichText(draft.name || 'NAI Archive') } };
        if (prefs.image && upload) properties.Image = { files: [{ type: 'file_upload', file_upload: { id: upload.id }, name: upload.filename }] };
        if (prefs.basePrompt) properties['Base Prompt'] = { rich_text: naiNotionRichText(draft.basePrompt) };
        if (prefs.negativePrompt) properties['Undesired Content'] = { rich_text: naiNotionRichText(draft.negativePrompt) };
        if (prefs.characterPrompt) {
            properties['Character Prompt'] = { rich_text: naiNotionRichText(naiNotionFormatCharacters(draft.characters, 'prompt')) };
            properties['Character Negative'] = { rich_text: naiNotionRichText(naiNotionFormatCharacters(draft.characters, 'negative')) };
            properties['Character Data'] = { rich_text: naiNotionRichText(JSON.stringify(draft.characters || [])) };
        }
        if (prefs.seed) properties.Seed = { rich_text: naiNotionRichText(draft.seed) };
        if (prefs.steps && Number.isFinite(draft.steps)) properties.Steps = { number: draft.steps };
        if (prefs.guidance && Number.isFinite(draft.guidance)) properties.Guidance = { number: draft.guidance };
        if (prefs.guidanceRescale && Number.isFinite(draft.guidanceRescale)) properties['Prompt Guidance Rescale'] = { number: draft.guidanceRescale };
        properties.Categories = { multi_select: normalizeLibraryCategoryList(draft.categories).map(name => ({ name })) };
        properties.Memo = { rich_text: naiNotionRichText(draft.memo) };
        if (draft.sourceUrl) properties.Source = { url: draft.sourceUrl };
        if (Number.isFinite(draft.width)) properties.Width = { number: draft.width };
        if (Number.isFinite(draft.height)) properties.Height = { number: draft.height };
        return properties;
    }

    async function naiNotionCreatePage(token, archive, draft, prefs, upload) {
        return await naiNotionJson(token, 'POST', '/v1/pages', {
            parent: { type: 'data_source_id', data_source_id: archive.dataSourceId },
            properties: naiNotionPageProperties(draft, prefs, upload)
        }, 'page-create');
    }

    async function naiNotionQueryAll(token, dataSourceId) {
        const results = [];
        let cursor = '';
        do {
            const body = { page_size: 100, sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }] };
            if (cursor) body.start_cursor = cursor;
            const response = await naiNotionJson(token, 'POST', `/v1/data_sources/${dataSourceId}/query`, body, 'db-query');
            results.push(...(response?.results || []));
            cursor = response?.has_more ? (response.next_cursor || '') : '';
        } while (cursor);
        return results;
    }

    function naiNotionParseCharacters(props) {
        const machine = naiNotionPlainRichText(props['Character Data']);
        if (machine) {
            try { return normalizeCharacterRows(JSON.parse(machine)); } catch (_) {}
        }
        const positive = naiNotionPlainRichText(props['Character Prompt']);
        const negative = naiNotionPlainRichText(props['Character Negative']);
        const parse = text => {
            const rows = [];
            const re = /^\[([^\]]+)\]\s*([\s\S]*?)(?=\n\n\[[^\]]+\]\s*|$)/gm;
            let match;
            while ((match = re.exec(text || ''))) rows.push({ name: match[1], value: match[2].trim() });
            if (!rows.length && String(text || '').trim()) rows.push({ name: 'Character 1', value: String(text).trim() });
            return rows;
        };
        const pos = parse(positive), neg = parse(negative);
        const count = Math.max(pos.length, neg.length);
        return Array.from({ length: count }, (_, i) => ({
            name: pos[i]?.name || neg[i]?.name || `Character ${i + 1}`,
            prompt: pos[i]?.value || '',
            negativePrompt: neg[i]?.value || ''
        })).filter(x => x.prompt || x.negativePrompt);
    }

    function naiNotionParseEditableCharacterText(positive, negative) {
        const parse = text => {
            const source = String(text || '').trim();
            if (!source) return [];
            const rows = [];
            const re = /^\[([^\]]+)\]\s*([\s\S]*?)(?=\n\n\[[^\]]+\]\s*|$)/gm;
            let match;
            while ((match = re.exec(source))) {
                rows.push({ name: String(match[1] || '').trim(), value: String(match[2] || '').trim() });
            }
            if (!rows.length) rows.push({ name: 'Character 1', value: source });
            return rows;
        };
        const pos = parse(positive);
        const neg = parse(negative);
        const count = Math.max(pos.length, neg.length);
        return normalizeCharacterRows(Array.from({ length: count }, (_, i) => ({
            name: pos[i]?.name || neg[i]?.name || `Character ${i + 1}`,
            prompt: pos[i]?.value || '',
            negativePrompt: neg[i]?.value || ''
        })));
    }

    function naiNotionMapPage(page) {
        const props = page?.properties || {};
        const files = props.Image?.files || [];
        const file = files[0] || null;
        const imageUrl = file?.file?.url || file?.external?.url || '';
        const categories = (props.Categories?.multi_select || []).map(x => x?.name).filter(Boolean);
        return normalizeConceptRecord({
            id: page.id,
            name: naiNotionPlainRichText(props.Name) || 'Untitled',
            tags: naiNotionPlainRichText(props['Base Prompt']),
            negativeTags: naiNotionPlainRichText(props['Undesired Content']),
            characters: naiNotionParseCharacters(props),
            note: naiNotionPlainRichText(props.Memo),
            categories,
            source: { type: 'Notion', url: props.Source?.url || page.url || '', rootUrl: page.url || '' },
            createdAt: Date.parse(page.created_time || '') || Date.now(),
            updatedAt: Date.parse(page.last_edited_time || '') || Date.now(),
            _notionPageId: page.id,
            _notionPageUrl: page.url || '',
            _notionLastEdited: page.last_edited_time || '',
            _notionImageUrl: imageUrl,
            _notionImageName: file?.name || '',
            _notionSeed: naiNotionPlainRichText(props.Seed),
            _notionSteps: props.Steps?.number ?? null,
            _notionGuidance: props.Guidance?.number ?? null,
            _notionGuidanceRescale: props['Prompt Guidance Rescale']?.number ?? null,
            _notionWidth: props.Width?.number ?? null,
            _notionHeight: props.Height?.number ?? null
        });
    }

    function naiNotionNormalizeCache(raw, fallbackDataSourceId = '') {
        if (!raw || typeof raw !== 'object') return { dataSourceId: String(fallbackDataSourceId || ''), lastSync: 0, items: [] };
        return {
            dataSourceId: String(raw.dataSourceId || fallbackDataSourceId || ''),
            lastSync: Number(raw.lastSync || 0),
            items: Array.isArray(raw.items) ? raw.items.map(normalizeConceptRecord) : []
        };
    }

    function naiNotionLoadCache(dataSourceId = naiNotionGetConnection().dataSourceId) {
        const id = String(dataSourceId || '');
        const map = GM_getValue(NAI_NOTION.cacheMapKey, {});
        if (id && map && typeof map === 'object' && map[id]) return naiNotionNormalizeCache(map[id], id);
        const legacy = naiNotionNormalizeCache(GM_getValue(NAI_NOTION.cacheKey, null));
        if (!id || !legacy.dataSourceId || legacy.dataSourceId === id) return legacy;
        return { dataSourceId: id, lastSync: 0, items: [] };
    }

    function naiNotionSaveCache(cache) {
        const safe = {
            dataSourceId: String(cache?.dataSourceId || ''),
            lastSync: Number(cache?.lastSync || Date.now()),
            items: (cache?.items || []).map(item => {
                const { _notionImageUrl, ...rest } = item;
                return { ...rest, _notionImageUrl: String(_notionImageUrl || '') };
            })
        };
        GM_setValue(NAI_NOTION.cacheKey, safe);
        if (safe.dataSourceId) {
            const rawMap = GM_getValue(NAI_NOTION.cacheMapKey, {});
            const map = rawMap && typeof rawMap === 'object' ? { ...rawMap } : {};
            map[safe.dataSourceId] = safe;
            GM_setValue(NAI_NOTION.cacheMapKey, map);
        }
        naiNotionState.cache = safe;
        return safe;
    }

    function naiNotionCurrentCache() {
        const dataSourceId = naiNotionGetConnection().dataSourceId;
        if (!naiNotionState.cache || String(naiNotionState.cache.dataSourceId || '') !== String(dataSourceId || '')) {
            naiNotionState.cache = naiNotionLoadCache(dataSourceId);
        }
        return naiNotionState.cache;
    }

    function naiNotionOpenThumbDb() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(NAI_NOTION.thumbDb, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(NAI_NOTION.thumbStore)) db.createObjectStore(NAI_NOTION.thumbStore, { keyPath: 'pageId' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function naiNotionThumbGet(pageId, lastEdited) {
        try {
            const db = await naiNotionOpenThumbDb();
            return await new Promise(resolve => {
                const tx = db.transaction(NAI_NOTION.thumbStore, 'readonly');
                const req = tx.objectStore(NAI_NOTION.thumbStore).get(pageId);
                req.onsuccess = () => resolve(req.result?.lastEdited === lastEdited ? req.result : null);
                req.onerror = () => resolve(null);
            });
        } catch (_) { return null; }
    }

    async function naiNotionThumbPut(pageId, lastEdited, blob) {
        try {
            const db = await naiNotionOpenThumbDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(NAI_NOTION.thumbStore, 'readwrite');
                tx.objectStore(NAI_NOTION.thumbStore).put({ pageId, lastEdited, blob, savedAt: Date.now() });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) {}
    }

    async function naiNotionThumbClear() {
        try {
            const db = await naiNotionOpenThumbDb();
            await new Promise(resolve => {
                const tx = db.transaction(NAI_NOTION.thumbStore, 'readwrite');
                tx.objectStore(NAI_NOTION.thumbStore).clear();
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch (_) {}
    }

    async function naiNotionThumbDelete(pageId) {
        if (!pageId) return;
        try {
            const db = await naiNotionOpenThumbDb();
            await new Promise(resolve => {
                const tx = db.transaction(NAI_NOTION.thumbStore, 'readwrite');
                tx.objectStore(NAI_NOTION.thumbStore).delete(pageId);
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch (_) {}
    }

    async function naiNotionFetchBlob(url) {
        if (!url) return null;
        const response = await naiNotionGmRequest({ method: 'GET', url, responseType: 'blob', timeout: 60000, context: 'thumbnail' });
        return response.response instanceof Blob ? response.response : null;
    }

    async function naiNotionCreateThumbnail(sourceBlob, maxWidth = 420) {
        if (!sourceBlob) return null;
        let bitmap = null;
        try {
            bitmap = await createImageBitmap(sourceBlob);
            const scale = Math.min(1, maxWidth / Math.max(1, bitmap.width));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const ctx = canvas.getContext('2d', { alpha: false });
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82));
        } catch (_) {
            return sourceBlob;
        } finally {
            try { bitmap?.close?.(); } catch (_) {}
        }
    }

    async function naiNotionHydrateThumbnail(img, item) {
        if (!img || !item?._notionPageId) return;
        const cached = await naiNotionThumbGet(item._notionPageId, item._notionLastEdited || '');
        if (cached?.blob) {
            const url = URL.createObjectURL(cached.blob);
            img.src = url;
            img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
            return;
        }
        if (!item._notionImageUrl) return;
        try {
            const raw = await naiNotionFetchBlob(item._notionImageUrl);
            const thumb = await naiNotionCreateThumbnail(raw);
            if (!thumb) return;
            await naiNotionThumbPut(item._notionPageId, item._notionLastEdited || '', thumb);
            const url = URL.createObjectURL(thumb);
            img.src = url;
            img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        } catch (_) {}
    }

    async function naiNotionHydrateOriginal(img, item) {
        if (!img || !item?._notionImageUrl) return;
        try {
            const raw = await naiNotionFetchBlob(item._notionImageUrl);
            if (!raw) return;
            const url = URL.createObjectURL(raw);
            img.src = url;
            img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
        } catch (_) {
            /* The Notion file URL may have expired. A later sync refreshes it. */
        }
    }

    function naiNotionBlockRichText(block) {
        const payload = block?.[block?.type] || {};
        const rows = payload?.rich_text || payload?.caption || [];
        if (!Array.isArray(rows)) return '';
        return rows.map(row => row?.plain_text ?? row?.text?.content ?? '').join('');
    }

    async function naiNotionReadPageBlocks(token, pageId, maxChars = 60000) {
        const blocks = [];
        const seen = new Set();
        let charCount = 0;

        async function walk(blockId, depth = 0) {
            if (!blockId || depth > 6 || charCount >= maxChars) return;
            let cursor = '';
            do {
                const q = new URLSearchParams({ page_size: '100' });
                if (cursor) q.set('start_cursor', cursor);
                const response = await naiNotionJson(
                    token,
                    'GET',
                    `/v1/blocks/${blockId}/children?${q}`,
                    undefined,
                    'page-body'
                );
                for (const block of response?.results || []) {
                    if (!block?.id || seen.has(block.id)) continue;
                    seen.add(block.id);
                    const text = naiNotionBlockRichText(block).trim();
                    if (text) {
                        blocks.push({
                            id: block.id,
                            type: String(block.type || ''),
                            text,
                            depth
                        });
                        charCount += text.length + 1;
                    }
                    if (block.has_children && charCount < maxChars) {
                        await walk(block.id, depth + 1);
                    }
                    if (charCount >= maxChars) break;
                }
                cursor = response?.has_more ? (response.next_cursor || '') : '';
            } while (cursor && charCount < maxChars);
        }

        await walk(pageId, 0);
        return blocks;
    }

    async function naiNotionReadPageBody(token, pageId, maxChars = 60000) {
        const blocks = await naiNotionReadPageBlocks(token, pageId, maxChars);
        return blocks.map(block => block.text).join('\n').slice(0, maxChars).trim();
    }

    function naiNotionParseLegacyCharacterBlock(text) {
        const source = String(text || '').trim();
        if (!source) return [];

        const parts = source.split(/\n\s*\n+/).map(part => part.trim()).filter(Boolean);
        const byIndex = new Map();
        let nextPositiveIndex = 1;

        const ensure = index => {
            const key = Math.max(1, Number(index) || 1);
            if (!byIndex.has(key)) {
                byIndex.set(key, {
                    name: `Character ${key}`,
                    prompt: '',
                    negativePrompt: ''
                });
            }
            return byIndex.get(key);
        };

        for (const part of parts) {
            let match = part.match(/^\[Char(?:acter)?\s*(\d+)\s+UC\]\s*([\s\S]*)$/i);
            if (match) {
                ensure(match[1]).negativePrompt = String(match[2] || '').trim();
                continue;
            }

            match = part.match(/^\[Character\s+UC\]\s*([\s\S]*)$/i);
            if (match) {
                ensure(1).negativePrompt = String(match[1] || '').trim();
                continue;
            }

            match = part.match(/^\[Char(?:acter)?\s*(\d+)\]\s*([\s\S]*)$/i);
            if (match) {
                const row = ensure(match[1]);
                row.prompt = String(match[2] || '').trim();
                nextPositiveIndex = Math.max(nextPositiveIndex, Number(match[1]) + 1);
                continue;
            }

            // v1.0.x wrote a single character prompt without a [Char 1] label.
            const row = ensure(nextPositiveIndex === 1 ? 1 : nextPositiveIndex);
            if (row.prompt) row.prompt += `\n\n${part}`;
            else row.prompt = part;
            nextPositiveIndex += 1;
        }

        return normalizeCharacterRows(
            [...byIndex.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([, row]) => row)
        );
    }

    function naiNotionParsePromptBlocks(blocks) {
        const result = {
            tags: '',
            negativeTags: '',
            characters: []
        };

        const headingToKey = text => {
            const key = String(text || '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
            if (/^(base|common|scene) prompt$/.test(key) || key === 'prompt') return 'tags';
            if (/^(negative prompt|undesired content|undesired|uc)$/.test(key)) return 'negativeTags';
            if (/^character prompt$/.test(key)) return 'characters';
            return '';
        };

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];
            if (!/^heading_[123]$/.test(block.type)) continue;
            const key = headingToKey(block.text);
            if (!key) continue;

            const values = [];
            for (let j = i + 1; j < blocks.length; j++) {
                const next = blocks[j];
                if (/^heading_[123]$/.test(next.type)) break;
                if (next.text) values.push(next.text);
            }

            const value = values.join('\n\n').trim();
            if (!value) continue;

            if (key === 'characters') {
                result.characters = naiNotionParseLegacyCharacterBlock(value);
            } else if (!result[key]) {
                result[key] = value;
            }
        }

        return result;
    }

    async function naiNotionRecoverPromptBlocks(token, pages, items, quiet = false) {
        const missing = items
            .map((item, index) => naiNotionItemHasPrompt(item) ? -1 : index)
            .filter(index => index >= 0);

        if (!missing.length) {
            return { items, filled: 0, skipped: 0, reason: '' };
        }

        let filled = 0;
        for (let pos = 0; pos < missing.length; pos++) {
            const index = missing[pos];
            const page = pages[index];
            const current = items[index];
            if (!page?.id || !current) continue;

            if (!quiet) {
                naiNotionSetLibraryStatus(
                    `본문 Prompt 직접 읽는 중… ${pos + 1}/${missing.length}`
                );
            }

            try {
                const blocks = await naiNotionReadPageBlocks(token, page.id);
                const parsed = naiNotionParsePromptBlocks(blocks);
                if (
                    !String(parsed.tags || '').trim() &&
                    !String(parsed.negativeTags || '').trim() &&
                    !normalizeCharacterRows(parsed.characters).length
                ) {
                    continue;
                }

                items[index] = normalizeConceptRecord({
                    ...current,
                    tags: parsed.tags || current.tags || '',
                    negativeTags: parsed.negativeTags || current.negativeTags || '',
                    characters: normalizeCharacterRows(parsed.characters).length
                        ? parsed.characters
                        : current.characters || []
                });
                filled += 1;
            } catch (error) {
                console.warn(
                    `[${APP_NAME}] Notion prompt block read skipped`,
                    page?.id,
                    error
                );
            }
        }

        return {
            items,
            filled,
            skipped: Math.max(0, missing.length - filled),
            reason: ''
        };
    }

    function naiNotionItemHasPrompt(item) {
        return Boolean(
            String(item?.tags || '').trim() ||
            String(item?.negativeTags || '').trim() ||
            normalizeCharacterRows(item?.characters).some(row => String(row.prompt || row.negativePrompt || '').trim())
        );
    }

    async function naiNotionGeminiFillMissingPrompts(token, pages, items, quiet = false) {
        const missing = items.map((item, index) => naiNotionItemHasPrompt(item) ? -1 : index).filter(index => index >= 0);
        if (!missing.length) return { items, filled: 0, skipped: 0, reason: '' };

        const settings = getSettings();
        const settingsError = validateSettings(settings);
        if (settingsError) return { items, filled: 0, skipped: missing.length, reason: settingsError };

        const extractedPages = [];
        for (let pos = 0; pos < missing.length; pos++) {
            const index = missing[pos];
            const page = pages[index];
            const item = items[index];
            if (!page?.id) continue;
            if (!quiet) naiNotionSetLibraryStatus(`빈 Prompt 본문 읽는 중… ${pos + 1}/${missing.length}`);
            try {
                const text = await naiNotionReadPageBody(token, page.id);
                if (text.length >= 20) {
                    extractedPages.push({
                        url: item._notionPageUrl || page.url || `notion-page://${page.id}`,
                        title: item.name || 'Untitled',
                        text,
                        depth: 0,
                        itemIndex: index
                    });
                }
            } catch (error) {
                console.warn(`[${APP_NAME}] Notion page body read skipped`, page?.id, error);
            }
        }
        if (!extractedPages.length) return { items, filled: 0, skipped: missing.length, reason: '페이지 본문을 읽지 못했습니다.' };

        let filled = 0;
        const batches = splitRenderedNotionPagesIntoBatches(extractedPages, 90000);
        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            if (!quiet) naiNotionSetLibraryStatus(`Gemini로 빈 Prompt 추출 중… ${b + 1}/${batches.length}`);
            try {
                const response = await callProvider(
                    buildRenderedNotionBatchPrompt(naiNotionGetConnection().databaseUrl || '', batch, settings),
                    settings,
                    { useUrlContext: false, jsonMode: true }
                );
                const parsed = parseRenderedNotionBatchJson(response.text, batch);
                const byUrl = new Map();
                for (const concept of parsed.concepts || []) if (!byUrl.has(concept.sourceUrl)) byUrl.set(concept.sourceUrl, concept);
                for (const pageInfo of batch) {
                    const concept = byUrl.get(pageInfo.url);
                    const current = items[pageInfo.itemIndex];
                    if (!concept || !current || naiNotionItemHasPrompt(current)) continue;
                    items[pageInfo.itemIndex] = normalizeConceptRecord({
                        ...current,
                        tags: concept.tags || '',
                        negativeTags: concept.negativeTags || '',
                        characters: concept.characters || [],
                        note: current.note || concept.note || ''
                    });
                    filled += 1;
                }
            } catch (error) {
                console.warn(`[${APP_NAME}] Gemini prompt recovery batch failed`, error);
            }
        }
        return { items, filled, skipped: Math.max(0, missing.length - filled), reason: '' };
    }

    async function naiNotionSyncPersonal({ force = false, quiet = false } = {}) {
        if (naiNotionState.syncing) return naiNotionCurrentCache();
        naiNotionState.syncing = true;
        try {
            const token = naiNotionReadToken();
            if (!token) throw new Error('Notion API Token이 없습니다.');

            // Fast path: a known selected data source can be queried directly. Schema discovery
            // belongs to connection/setup, not every refresh.
            let connection = naiNotionGetConnection();
            if (!connection?.dataSourceId) {
                if (!quiet) naiNotionSetLibraryStatus('Notion 저장소 연결을 확인하는 중…');
                connection = await naiNotionEnsureArchive(token, true);
            }
            if (!connection?.dataSourceId) throw new Error('연결된 Notion 저장소의 Data Source ID를 확인하지 못했습니다.');

            if (!quiet) naiNotionSetLibraryStatus('Notion에서 항목을 불러오는 중…');
            const pages = await naiNotionQueryAll(token, connection.dataSourceId);
            const old = naiNotionLoadCache(connection.dataSourceId);
            const oldById = new Map((old.items || []).map(item => [item._notionPageId || item.id, item]));
            let items = pages.map(page => {
                const mapped = naiNotionMapPage(page);
                const before = oldById.get(page.id);
                if (before && before._notionLastEdited === mapped._notionLastEdited) {
                    return { ...before, _notionImageUrl: mapped._notionImageUrl || before._notionImageUrl, _notionPageUrl: mapped._notionPageUrl || before._notionPageUrl };
                }
                return mapped;
            });

            // Commit and render the Notion rows immediately. Gemini recovery is secondary and
            // must never keep the personal library blank while it is working or failing.
            let next = naiNotionSaveCache({ dataSourceId: connection.dataSourceId, lastSync: Date.now(), items });
            if (naiNotionState.mode === 'personal') naiNotionController?.renderLibraryPanel?.();
            if (!quiet) naiNotionSetLibraryStatus(`Notion 항목 ${items.length}개 불러옴${items.length ? ' · 빈 Prompt 확인 중…' : ''}`);

            if (!items.length) {
                if (!quiet) naiNotionSetLibraryStatus('동기화 완료 · 0개 (현재 선택한 Notion 저장소에 항목이 없습니다.)');
                return next;
            }

            // Older NAI → Notion versions store Prompt fields as heading + code blocks
            // in each page body by default. Recover that format deterministically first;
            // the personal library must not depend on Gemini/Firebase just to read its own data.
            const recovered = await naiNotionRecoverPromptBlocks(token, pages, items, quiet);
            items = recovered.items;
            next = naiNotionSaveCache({ dataSourceId: connection.dataSourceId, lastSync: Date.now(), items });
            if (naiNotionState.mode === 'personal') naiNotionController?.renderLibraryPanel?.();

            if (!quiet) {
                let message = `동기화 완료 · ${items.length}개`;
                if (recovered.filled) message += ` · 본문 Prompt 복구 ${recovered.filled}개`;
                if (recovered.skipped) message += ` · 빈 Prompt ${recovered.skipped}개`;
                naiNotionSetLibraryStatus(message);
            }
            return next;
        } catch (error) {
            naiNotionState.lastError = naiNotionHumanizeError(error);
            naiNotionSetLibraryStatus(naiNotionState.lastError, true);
            throw error;
        } finally {
            naiNotionState.syncing = false;
        }
    }

    async function naiNotionUpdatePage(item, next) {
        const token = naiNotionReadToken();
        if (!token) throw new Error('Notion API Token이 없습니다.');
        const pageId = item._notionPageId || item.id;
        const properties = {
            Name: { title: naiNotionRichText(next.name) },
            'Base Prompt': { rich_text: naiNotionRichText(next.tags) },
            'Undesired Content': { rich_text: naiNotionRichText(next.negativeTags) },
            'Character Prompt': { rich_text: naiNotionRichText(naiNotionFormatCharacters(next.characters, 'prompt')) },
            'Character Negative': { rich_text: naiNotionRichText(naiNotionFormatCharacters(next.characters, 'negative')) },
            'Character Data': { rich_text: naiNotionRichText(JSON.stringify(next.characters || [])) },
            Categories: { multi_select: normalizeLibraryCategoryList(next.categories).map(name => ({ name })) },
            Memo: { rich_text: naiNotionRichText(next.note || '') }
        };
        await naiNotionJson(token, 'PATCH', `/v1/pages/${pageId}`, { properties }, 'page-update');
        await naiNotionSyncPersonal({ force: true, quiet: true });
    }

    async function naiNotionDeletePage(item) {
        const token = naiNotionReadToken();
        if (!token) throw new Error('Notion API Token이 없습니다.');
        const pageId = item._notionPageId || item.id;
        await naiNotionJson(token, 'PATCH', `/v1/pages/${pageId}`, { in_trash: true }, 'page-delete');
        const cache = naiNotionCurrentCache();
        naiNotionSaveCache({ ...cache, items: cache.items.filter(row => (row._notionPageId || row.id) !== pageId), lastSync: Date.now() });
        await naiNotionThumbDelete(pageId);
    }

    async function naiNotionSetEditorText(editor, value) {
        if (!editor) return { ok: false, error: 'NovelAI Prompt 입력창을 찾지 못했습니다.' };
        const text = String(value || '');
        try { editor.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
        try { editor.focus({ preventScroll: true }); } catch (_) { editor.focus(); }
        const doc = PAGE_WINDOW.document || document;
        const sel = PAGE_WINDOW.getSelection ? PAGE_WINDOW.getSelection() : window.getSelection();
        const range = doc.createRange();
        range.selectNodeContents(editor);
        sel.removeAllRanges();
        sel.addRange(range);
        let changed = false;
        try { changed = !!doc.execCommand?.('insertText', false, text); } catch (_) {}
        await waitMs(60);
        if (naiNotionEditorText(editor) === text.trim()) return { ok: true };
        try {
            editor.innerHTML = '';
            const p = doc.createElement('p');
            if (text) p.appendChild(doc.createTextNode(text));
            else p.appendChild(doc.createElement('br'));
            editor.appendChild(p);
            editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
            editor.dispatchEvent(new Event('change', { bubbles: true }));
            await waitMs(80);
            if (naiNotionEditorText(editor) === text.trim() || changed) return { ok: true };
        } catch (_) {}
        return { ok: false, error: 'Prompt 입력창은 찾았지만 교체 이벤트가 적용되지 않았습니다.' };
    }

    async function naiNotionClearExtraCharacters(target) {
        const count = getCharacterPromptCount();
        for (let index = count; index > target; index--) {
            const container = findCharacterPromptContainer(index);
            if (!container) continue;
            const deleteButton = [...container.querySelectorAll('button')].find(button => {
                const label = `${button.getAttribute('aria-label') || ''} ${button.title || ''}`.toLowerCase();
                return /remove|delete|삭제/.test(label) && !button.disabled;
            });
            if (deleteButton) {
                dispatchNovelAiButtonClick(deleteButton);
                await waitMs(120);
                continue;
            }
            const p = await activateCharacterPrompt(index, 'prompt');
            if (p.ok) await naiNotionSetEditorText(p.editor, '');
            const n = await activateCharacterPrompt(index, 'negative');
            if (n.ok) await naiNotionSetEditorText(n.editor, '');
        }
    }

    function naiNotionAppendPromptTail(current, addition) {
        const before = String(current || '').trim().replace(/[\s,]+$/g, '');
        const after = String(addition || '').trim().replace(/^[\s,]+/g, '');
        if (!before) return after;
        if (!after) return before;
        return `${before}, ${after}`;
    }

    function naiNotionPersonalBaseModeMap() {
        const raw = GM_getValue(NAI_NOTION.personalBaseModeKey, {});
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }

    function naiNotionPersonalBaseModeKeyForItem(item) {
        const conn = naiNotionGetConnection();
        const itemId = String(item?._notionPageId || item?.id || '');
        return `${String(conn.dataSourceId || 'default')}:${itemId}`;
    }

    function naiNotionGetPersonalBaseMode(item) {
        const map = naiNotionPersonalBaseModeMap();
        return map[naiNotionPersonalBaseModeKeyForItem(item)] === 'append'
            ? 'append'
            : 'replace';
    }

    function naiNotionSetPersonalBaseMode(item, mode) {
        const map = naiNotionPersonalBaseModeMap();
        map[naiNotionPersonalBaseModeKeyForItem(item)] =
            mode === 'append' ? 'append' : 'replace';
        GM_setValue(NAI_NOTION.personalBaseModeKey, map);
    }

    async function naiNotionReplaceConceptInNovelAI(item, baseMode = 'replace') {
        const normalized = normalizeConceptRecord(item);
        const positive = String(normalized.tags || '').trim();
        const negative = String(normalized.negativeTags || '').trim();
        const characters = normalizeCharacterRows(normalized.characters);
        let result = { ok: true };

        // Personal-library presets are partial presets, not full snapshots.
        // Only touch fields that actually contain content. This prevents a
        // character-only preset from wiping the current Base Prompt / UC.
        if (positive) {
            const base = await activateMainPrompt('base');
            if (!base.ok) return base;
            const baseValue =
                baseMode === 'append'
                    ? naiNotionAppendPromptTail(
                        naiNotionEditorText(base.editor),
                        positive
                    )
                    : positive;
            result = await naiNotionSetEditorText(base.editor, baseValue);
            if (!result.ok) return result;
        }

        if (negative) {
            const neg = await activateMainPrompt('negative');
            if (!neg.ok) return neg;
            result = await naiNotionSetEditorText(neg.editor, negative);
            if (!result.ok) return result;
        }

        // Only replace Character fields that actually exist in this preset.
        // Never delete, clear, or otherwise touch empty Character fields or
        // Character 2+ just because the applied preset contains fewer rows.
        if (characters.length > 0) {
            const ensured = await ensureCharacterPromptCount(characters.length);
            if (!ensured.ok) return ensured;

            for (let i = 0; i < characters.length; i++) {
                const index = i + 1;
                const characterPrompt = String(characters[i].prompt || '').trim();
                const characterNegative = String(characters[i].negativePrompt || '').trim();

                if (characterPrompt) {
                    const p = await activateCharacterPrompt(index, 'prompt');
                    if (!p.ok) return p;
                    result = await naiNotionSetEditorText(p.editor, characterPrompt);
                    if (!result.ok) return result;
                }

                if (characterNegative) {
                    const n = await activateCharacterPrompt(index, 'negative');
                    if (!n.ok) return n;
                    result = await naiNotionSetEditorText(n.editor, characterNegative);
                    if (!result.ok) return result;
                }

                if (characterPrompt || characterNegative) {
                    await activateCharacterPrompt(index, 'prompt');
                }
            }
        }

        await activateMainPrompt('base');
        return {
            ok: true,
            insertedPositive: !!positive,
            insertedNegative: !!negative,
            insertedCharacters: characters.filter(x => String(x.prompt || '').trim()).length,
            insertedCharacterNegatives: characters.filter(x => String(x.negativePrompt || '').trim()).length
        };
    }

    function naiNotionExternalCharacterRows(item) {
        const normalized = normalizeConceptRecord(item);
        let rows = normalizeCharacterRows(normalized.characters)
            .map(row => ({
                name: String(row.name || normalized.name || 'Character').trim(),
                prompt: String(row.prompt || '').trim(),
                negativePrompt: String(row.negativePrompt || '').trim()
            }))
            .filter(row => row.prompt || row.negativePrompt);

        const basePrompt = String(normalized.tags || '').trim();
        const baseNegative = String(normalized.negativeTags || '').trim();

        // Public Notion character libraries often expose their character prompt
        // through a generic Prompt/Base Prompt field.  For external libraries,
        // never touch NovelAI's main prompt: fold those fields into Character 1.
        if (!rows.length && (basePrompt || baseNegative)) {
            rows = [{
                name: String(normalized.name || 'Character').trim(),
                prompt: basePrompt,
                negativePrompt: baseNegative
            }];
        } else if (rows.length) {
            if (basePrompt) {
                rows[0].prompt = [basePrompt, rows[0].prompt]
                    .filter(Boolean)
                    .join(',\n');
            }
            if (baseNegative) {
                rows[0].negativePrompt = [baseNegative, rows[0].negativePrompt]
                    .filter(Boolean)
                    .join(',\n');
            }
        }

        return rows;
    }

    function naiNotionExternalCharacterCopyText(item) {
        const rows = naiNotionExternalCharacterRows(item);
        return rows.map((row, index) => {
            const parts = [];
            if (rows.length > 1) parts.push(`[Character ${index + 1}]`);
            if (row.prompt) parts.push(row.prompt);
            if (row.negativePrompt) parts.push(`[Character UC]\n${row.negativePrompt}`);
            return parts.join('\n');
        }).filter(Boolean).join('\n\n');
    }

    async function naiNotionUseExternalAsBase(item, baseMode = 'replace') {
        const normalized = normalizeConceptRecord(item);
        const positive = String(normalized.tags || '').trim();
        const negative = String(normalized.negativeTags || '').trim();
        if (!positive && !negative) {
            return { ok: false, error: 'Base Prompt에 적용할 Prompt/UC가 비어 있습니다.' };
        }

        if (positive) {
            const base = await activateMainPrompt('base');
            if (!base.ok) return base;
            const value =
                baseMode === 'append'
                    ? naiNotionAppendPromptTail(
                        naiNotionEditorText(base.editor),
                        positive
                    )
                    : positive;
            const result = await naiNotionSetEditorText(base.editor, value);
            if (!result.ok) return result;
        }
        if (negative) {
            const neg = await activateMainPrompt('negative');
            if (!neg.ok) return neg;
            const result = await naiNotionSetEditorText(neg.editor, negative);
            if (!result.ok) return result;
        }
        await activateMainPrompt('base');
        return { ok: true, appliedBase: !!positive, appliedNegative: !!negative };
    }

    async function naiNotionReplaceExternalCharacters(item) {
        const rows = naiNotionExternalCharacterRows(item);
        if (!rows.length) {
            return { ok: false, error: 'Character Prompt로 교체할 내용이 비어 있습니다.' };
        }

        // External libraries are preset libraries, not full NovelAI snapshots.
        // Fast path: replace Character 1 only.  Do not enumerate/delete every
        // existing Character slot because that made a cached preset feel much
        // slower than the personal library.
        const row = rows[0];
        if (getCharacterPromptCount() < 1) {
            const ensured = await ensureCharacterPromptCount(1);
            if (!ensured.ok) return ensured;
        }

        const promptTab = await activateCharacterPrompt(1, 'prompt');
        if (!promptTab.ok) return promptTab;
        let result = await naiNotionSetEditorText(promptTab.editor, row.prompt || '');
        if (!result.ok) return result;

        const negativeTab = await activateCharacterPrompt(1, 'negative');
        if (!negativeTab.ok) return negativeTab;
        result = await naiNotionSetEditorText(negativeTab.editor, row.negativePrompt || '');
        if (!result.ok) return result;

        // Return to the positive Character prompt, but do not touch other slots.
        await activateCharacterPrompt(1, 'prompt');

        return {
            ok: true,
            insertedCharacters: row.prompt ? 1 : 0,
            insertedCharacterNegatives: row.negativePrompt ? 1 : 0,
            ignoredExtraPresetRows: Math.max(0, rows.length - 1)
        };
    }

    function naiNotionExternalApplyPrefs(source, database) {
        return {
            target:
                String(database?.applyTarget || source?.applyTarget || '') === 'character'
                    ? 'character'
                    : 'base',
            baseMode:
                String(database?.baseMode || source?.baseMode || '') === 'append'
                    ? 'append'
                    : 'replace'
        };
    }

    function naiNotionExternalPrefsForItem(item) {
        const sources = naiNotionGetExternalSources();
        const source = sources.find(
            row => String(row.id) === String(item?._externalSourceId || '')
        );
        if (!source) return { target: 'base', baseMode: 'replace' };

        const database = Array.isArray(source.databases)
            ? source.databases.find(
                db => String(db.id) === String(item?._externalDatabaseId || '')
            )
            : null;
        return naiNotionExternalApplyPrefs(source, database);
    }

    function naiNotionUpdateExternalApplyPref(sourceId, databaseId, field, value) {
        const sources = naiNotionGetExternalSources();
        const index = sources.findIndex(
            source => String(source.id) === String(sourceId || '')
        );
        if (index < 0) return;

        const source = sources[index];
        const dbId = String(databaseId || '');
        const databases = Array.isArray(source.databases)
            ? [...source.databases]
            : [];
        const dbIndex = dbId
            ? databases.findIndex(db => String(db.id) === dbId)
            : -1;

        if (dbIndex >= 0) {
            databases[dbIndex] = {
                ...databases[dbIndex],
                [field]: value
            };
            sources[index] = { ...source, databases };
        } else {
            sources[index] = { ...source, [field]: value };
        }

        naiNotionSaveExternalSources(sources);
    }

    async function naiNotionUseExternalPreset(item) {
        const prefs = naiNotionExternalPrefsForItem(item);
        if (prefs.target === 'character') {
            return await naiNotionReplaceExternalCharacters(item);
        }
        return await naiNotionUseExternalAsBase(item, prefs.baseMode);
    }

    let naiNotionLibraryStatusClearTimer = 0;
    function naiNotionSetLibraryStatus(message, error = false) {
        const status = document.querySelector(`#${MODAL_ID} #nai-library-status`);
        if (naiNotionLibraryStatusClearTimer) {
            clearTimeout(naiNotionLibraryStatusClearTimer);
            naiNotionLibraryStatusClearTimer = 0;
        }
        if (!status) return;
        status.textContent = String(message || '');
        status.style.color = error ? '#ff8f9b' : '';
        if (error) {
            naiNotionLibraryStatusClearTimer = setTimeout(() => {
                const current = document.querySelector(`#${MODAL_ID} #nai-library-status`);
                if (current) {
                    current.textContent = '';
                    current.style.color = '';
                }
                naiNotionLibraryStatusClearTimer = 0;
            }, 7000);
        }
    }

    function naiNotionGetExternalSources() {
        const saved = GM_getValue(NAI_NOTION.externalSourcesKey, []);
        return Array.isArray(saved) ? saved : [];
    }

    function naiNotionSaveExternalSources(sources) {
        GM_setValue(NAI_NOTION.externalSourcesKey, Array.isArray(sources) ? sources : []);
    }

    function naiNotionSetExternalSourceStatus(sourceId, message, error = false) {
        const card = [...document.querySelectorAll('.nai-notion-external-source')]
            .find(node => String(node.dataset.nnSource || '') === String(sourceId || ''));
        const status = card?.querySelector('[data-nn-ext-status]');
        if (!status) return;

        status.textContent = String(message || '');
        status.classList.toggle('error', Boolean(error));
        status.hidden = !String(message || '').trim();
    }

    function naiNotionMutateExternalSource(sourceId, updater) {
        const sources = naiNotionGetExternalSources();
        const index = sources.findIndex(
            row => String(row.id) === String(sourceId)
        );
        if (index < 0) return null;

        const current = sources[index];
        const next =
            typeof updater === 'function'
                ? updater(current)
                : updater;

        if (!next) return current;
        sources[index] = next;
        naiNotionSaveExternalSources(sources);
        return next;
    }

    function naiNotionRevisionHash(value) {
        const raw = String(value || '');
        let hash = 2166136261;
        for (let i = 0; i < raw.length; i++) {
            hash ^= raw.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function naiNotionRevisionFromBlockMap(blockMap, onlyIds = null) {
        if (!blockMap || typeof blockMap !== 'object') return '';
        const wanted = onlyIds ? new Set([...onlyIds].map(String)) : null;
        const rows = [];

        for (const [fallbackId, record] of Object.entries(blockMap)) {
            const value = notionNetworkUnwrapRecord(record);
            if (!value) continue;

            const id = String(value.id || fallbackId);
            if (wanted && !wanted.has(id)) continue;

            rows.push([
                id,
                String(value.version ?? ''),
                String(value.last_edited_time ?? value.lastEditedTime ?? ''),
                String(value.type || ''),
                String(value.alive ?? ''),
                Array.isArray(value.content)
                    ? value.content.map(String).join(',')
                    : ''
            ].join('|'));
        }

        rows.sort();
        return rows.length
            ? naiNotionRevisionHash(rows.join('\n'))
            : '';
    }

    async function naiNotionCheckExternalSectionRevision(rootUrl, section) {
        const origin = new URL(rootUrl).origin;

        if (section?.kind === 'page') {
            const pageId = String(section?.pageId || section?.blockId || '');
            if (!pageId) return { revision: '', skippable: false };

            const result = await notionNetworkGmPostJson(
                `${origin}/api/v3/loadCachedPageChunkV2`,
                {
                    page: { id: pageId },
                    limit: 100,
                    cursor: { stack: [] },
                    chunkNumber: 0,
                    verticalColumns: false
                },
                'external page revision check'
            );

            const revision = naiNotionRevisionFromBlockMap(
                result?.data?.recordMap?.block
            );

            return {
                revision,
                skippable: Boolean(revision),
                kind: 'page'
            };
        }

        if (section?.blockId && section?.viewId) {
            const timeZone =
                Intl.DateTimeFormat().resolvedOptions().timeZone ||
                'Asia/Seoul';
            const result = await notionNetworkGmPostJson(
                `${origin}/api/v3/queryCollection?src=initial_load`,
                {
                    collectionView: {
                        id: String(section.viewId),
                        ...(section.spaceId
                            ? { spaceId: String(section.spaceId) }
                            : {})
                    },
                    clientType: 'notion_app',
                    collectionViewBlock: {
                        id: String(section.blockId),
                        ...(section.spaceId
                            ? { spaceId: String(section.spaceId) }
                            : {})
                    },
                    isFullScreen: true,
                    isMobile: false,
                    userTimeZone: timeZone
                },
                'external DB revision check'
            );

            const group =
                result?.data?.result?.reducerResults
                    ?.collection_group_results ||
                null;
            const rowIds = Array.isArray(group?.blockIds)
                ? group.blockIds.map(String)
                : [];
            const sizeHint = Math.max(
                Number(group?.sizeHint || 0),
                Number(result?.data?.result?.sizeHint || 0),
                rowIds.length
            );
            const hasMore = Boolean(group?.hasMore);
            const revision = naiNotionRevisionFromBlockMap(
                result?.data?.recordMap?.block,
                rowIds
            );
            const complete =
                !hasMore &&
                (!sizeHint || rowIds.length >= sizeHint);

            return {
                revision,
                skippable: Boolean(revision && complete),
                kind: 'database',
                rowCount: rowIds.length,
                sizeHint
            };
        }

        return { revision: '', skippable: false };
    }

    const naiNotionExternalBulkJobs = new Map();
    let naiNotionExternalDbDirectQueue = Promise.resolve();

    async function naiNotionWithExternalDbDirectLock(task) {
        const previous = naiNotionExternalDbDirectQueue;
        let release;
        naiNotionExternalDbDirectQueue = new Promise(resolve => {
            release = resolve;
        });

        await previous;
        try {
            return await task();
        } finally {
            release();
        }
    }

    function naiNotionBulkJobState(sourceId) {
        return naiNotionExternalBulkJobs.get(String(sourceId || '')) || null;
    }

    function naiNotionBulkStatusText(state) {
        if (!state) return '';
        if (state.running) {
            const active = [...(state.activeNames || [])].filter(Boolean);
            const suffix = active.length
                ? ` · ${active.slice(0, 3).join(', ')} 처리 중`
                : '';
            return `${state.done}/${state.total}${suffix}`;
        }

        const parts = [`완료 · 성공 ${state.success}`];
        if (state.skipped) parts.push(`변경 없음 ${state.skipped}`);
        if (state.failed) parts.push(`실패 ${state.failed}`);
        return parts.join(' · ');
    }

    function naiNotionRefreshBulkSyncViews(sourceId) {
        const id = String(sourceId || '');
        const state = naiNotionBulkJobState(id);
        const latestSource = naiNotionGetExternalSources().find(
            row => String(row.id) === id
        );

        document
            .querySelectorAll(
                `[data-nn-bulk-source="${CSS.escape(id)}"]`
            )
            .forEach(root => {
                const button = root.querySelector('[data-sync-all]');
                const status = root.querySelector('[data-sync-all-status]');

                if (button) {
                    button.disabled = Boolean(state?.running);
                    button.textContent = state?.running
                        ? '전체 동기화 중…'
                        : '전체 동기화';
                }

                if (status) {
                    status.textContent = naiNotionBulkStatusText(state);
                    status.classList.toggle(
                        'error',
                        Boolean(state && !state.running && state.failed)
                    );
                }

                for (const db of latestSource?.databases || []) {
                    const meta = root.querySelector(
                        `[data-db-meta="${CSS.escape(String(db.id))}"]`
                    );
                    if (!meta) continue;

                    const sectionState = state?.sectionStates?.get?.(
                        String(db.id)
                    );

                    if (sectionState?.status === 'running') {
                        meta.classList.remove('error');
                        meta.textContent =
                            sectionState.phase === 'checking'
                                ? '변경 확인 중…'
                                : '동기화 중…';
                        continue;
                    }

                    if (sectionState?.status === 'skipped') {
                        meta.classList.remove('error');
                        meta.textContent =
                            `변경 없음 · 캐시 ${Array.isArray(db.items) ? db.items.length : 0}개`;
                        continue;
                    }

                    if (sectionState?.status === 'failed') {
                        meta.classList.add('error');
                        meta.textContent =
                            `동기화 실패 · ${sectionState.shortError || '알 수 없는 오류'}`;
                        meta.title = sectionState.error || '';
                        continue;
                    }

                    meta.classList.remove('error');
                    meta.removeAttribute('title');
                    meta.textContent = db.lastSync
                        ? `캐시 ${Array.isArray(db.items) ? db.items.length : 0}개 · ${new Date(db.lastSync).toLocaleString()}`
                        : '동기화 전';
                }
            });
    }

    async function naiNotionSyncExternalSource(
        sourceId,
        databaseId = '',
        options = {}
    ) {
        let syncOutcome = {
            ok: false,
            error: '동기화가 완료되지 않았습니다.'
        };

        const initialSource = naiNotionGetExternalSources().find(
            row => String(row.id) === String(sourceId)
        );
        if (!initialSource) return syncOutcome;

        const initialDatabases = Array.isArray(initialSource.databases)
            ? initialSource.databases
            : [];
        const requestedId = String(databaseId || '');
        const targetDatabase = requestedId
            ? initialDatabases.find(
                db => String(db.id) === requestedId
            ) || null
            : null;
        const accessMode = notionExternalAccessMode(initialSource.url);

        if (!options.bulk) {
            naiNotionMutateExternalSource(sourceId, current => ({
                ...current,
                syncStatus: '',
                syncStatusError: false,
                error: ''
            }));
        }

        try {
            if (!options.bulk) {
                naiNotionSetExternalSourceStatus(
                    sourceId,
                    targetDatabase
                        ? `“${targetDatabase.name}” 동기화 중…`
                        : accessMode === 'guest'
                            ? '게스트 Notion · 분류 구조 직접 확인 중…'
                            : '분류 구조 직접 확인 중…'
                );
            }

            const settings = getSettings();
            const result = await analyzeNotionViaNetworkIntercept(
                initialSource.url,
                settings,
                message => {
                    if (!options.bulk) {
                        naiNotionSetExternalSourceStatus(sourceId, message);
                    }
                },
                targetDatabase
            );
            const now = Date.now();

            if (targetDatabase) {
                const hierarchyCategory = String(
                    targetDatabase.groupName || ''
                ).trim();
                const pageAssets = Array.isArray(result?.pageAssets)
                    ? result.pageAssets
                    : [];
                const assetByUrl = new Map(
                    pageAssets
                        .filter(row => row?.url)
                        .map(row => [String(row.url), row])
                );
                const assetByTitle = new Map(
                    pageAssets
                        .filter(row => row?.title)
                        .map(row => [String(row.title).trim(), row])
                );

                const items = (result?.concepts || []).map((raw, i) => {
                    const sourceUrl = String(
                        raw.sourceUrl || initialSource.url || ''
                    );
                    const sourceTitle = String(
                        raw.sourcePageTitle ||
                        raw.suggestedName ||
                        raw.name ||
                        ''
                    ).trim();
                    const asset =
                        assetByUrl.get(sourceUrl) ||
                        assetByTitle.get(sourceTitle) ||
                        null;

                    return normalizeConceptRecord({
                        id: `${sourceId}:${requestedId}:${raw.id || i}`,
                        name:
                            raw.suggestedName ||
                            raw.name ||
                            `Prompt ${i + 1}`,
                        tags: raw.tags || '',
                        negativeTags: raw.negativeTags || '',
                        characters: raw.characters || [],
                        note: raw.note || '',
                        categories: normalizeLibraryCategoryList([
                            ...(hierarchyCategory
                                ? [hierarchyCategory]
                                : []),
                            ...(Array.isArray(raw.categories)
                                ? raw.categories
                                : [])
                        ]),
                        source: {
                            type:
                                accessMode === 'guest'
                                    ? 'GuestNotion'
                                    : 'PublicNotion',
                            url: sourceUrl,
                            rootUrl: initialSource.url
                        },
                        createdAt: now,
                        updatedAt: now,
                        _externalSourceId: sourceId,
                        _externalDatabaseId: requestedId,
                        _notionImageUrl: String(
                            raw._notionImageUrl ||
                            raw.imageUrl ||
                            asset?.imageUrl ||
                            ''
                        )
                    });
                });

                const imageCount = items.filter(
                    item => item?._notionImageUrl
                ).length;

                const committed = naiNotionMutateExternalSource(
                    sourceId,
                    current => {
                        const currentDatabases = Array.isArray(
                            current.databases
                        )
                            ? current.databases
                            : [];

                        let found = false;
                        const nextDatabases = currentDatabases.map(db => {
                            if (String(db.id) !== requestedId) return db;
                            found = true;
                            return {
                                ...db,
                                ...targetDatabase,
                                items,
                                lastSync: now,
                                lastAttempt: now,
                                lastCheckedAt: now,
                                error: '',
                                ...(options.remoteRevision
                                    ? { remoteRevision: options.remoteRevision }
                                    : {}),
                                ...(typeof options.revisionSkippable === 'boolean'
                                    ? {
                                        revisionSkippable:
                                            options.revisionSkippable
                                    }
                                    : {})
                            };
                        });

                        if (!found) {
                            nextDatabases.push({
                                ...targetDatabase,
                                items,
                                lastSync: now,
                                lastAttempt: now,
                                lastCheckedAt: now,
                                error: '',
                                ...(options.remoteRevision
                                    ? { remoteRevision: options.remoteRevision }
                                    : {}),
                                ...(typeof options.revisionSkippable === 'boolean'
                                    ? {
                                        revisionSkippable:
                                            options.revisionSkippable
                                    }
                                    : {})
                            });
                        }

                        const selectedId =
                            options.preserveSelection
                                ? String(
                                    current.selectedDatabaseId ||
                                    nextDatabases[0]?.id ||
                                    ''
                                )
                                : requestedId;
                        const selectedDb = nextDatabases.find(
                            db => String(db.id) === selectedId
                        );

                        return {
                            ...current,
                            accessMode,
                            databases: nextDatabases,
                            selectedDatabaseId: selectedId,
                            items: selectedDb
                                ? selectedDb.items
                                : (current.items || []),
                            lastSync: now,
                            ...(options.bulk
                                ? {}
                                : {
                                    error: '',
                                    syncStatus:
                                        `동기화 완료 · ${items.length}개 · 이미지 ${imageCount}개`,
                                    syncStatusError: false
                                })
                        };
                    }
                );

                syncOutcome = {
                    ok: true,
                    sourceId,
                    sectionId: requestedId,
                    count: items.length,
                    imageCount,
                    source: committed
                };

                if (!options.bulk) {
                    naiNotionSetExternalSourceStatus(
                        sourceId,
                        `동기화 완료 · ${items.length}개 · 이미지 ${imageCount}개`
                    );
                }
            } else {
                const latestBeforeCommit =
                    naiNotionGetExternalSources().find(
                        row => String(row.id) === String(sourceId)
                    ) ||
                    initialSource;
                const currentDatabases = Array.isArray(
                    latestBeforeCommit.databases
                )
                    ? latestBeforeCommit.databases
                    : [];
                const discovered = naiNotionMergeExternalDatabases(
                    currentDatabases,
                    result?.externalDatabases || []
                );

                let activeId = String(
                    latestBeforeCommit.selectedDatabaseId || ''
                );
                if (
                    activeId &&
                    !discovered.some(db => String(db.id) === activeId)
                ) {
                    activeId = '';
                }

                const reportedId = String(
                    result?.activeExternalDatabaseId || ''
                );
                if (
                    !activeId &&
                    reportedId &&
                    discovered.some(db => String(db.id) === reportedId)
                ) {
                    activeId = reportedId;
                }
                if (!activeId && discovered.length) {
                    activeId = String(discovered[0].id);
                }

                const selectedDb = discovered.find(
                    db => String(db.id) === activeId
                );

                const committed = naiNotionMutateExternalSource(
                    sourceId,
                    current => ({
                        ...current,
                        accessMode,
                        databases: discovered,
                        selectedDatabaseId: activeId,
                        items: selectedDb
                            ? selectedDb.items
                            : (current.items || []),
                        lastSync: now,
                        error: '',
                        syncStatus:
                            `분류 목록 갱신 완료 · ${discovered.length}개`,
                        syncStatusError: false
                    })
                );

                syncOutcome = {
                    ok: true,
                    sourceId,
                    sectionId: activeId,
                    count: Array.isArray(selectedDb?.items)
                        ? selectedDb.items.length
                        : 0,
                    imageCount: Array.isArray(selectedDb?.items)
                        ? selectedDb.items.filter(
                            item => item?._notionImageUrl
                        ).length
                        : 0,
                    source: committed
                };

                naiNotionSetExternalSourceStatus(
                    sourceId,
                    `분류 목록 갱신 완료 · ${discovered.length}개`
                );
            }
        } catch (error) {
            const message = error?.message || String(error);

            naiNotionMutateExternalSource(sourceId, current => ({
                ...current,
                databases: targetDatabase
                    ? (current.databases || []).map(db =>
                        String(db.id) === requestedId
                            ? {
                                ...db,
                                error: message,
                                lastAttempt: Date.now()
                            }
                            : db
                    )
                    : (current.databases || []),
                lastAttempt: Date.now(),
                ...(options.bulk
                    ? {}
                    : {
                        error: message,
                        syncStatus:
                            `${message} · 기존 캐시는 유지했습니다.`,
                        syncStatusError: true
                    })
            }));

            if (!options.bulk) {
                naiNotionSetExternalSourceStatus(
                    sourceId,
                    `${message} · 기존 캐시는 유지했습니다.`,
                    true
                );
            }

            syncOutcome = {
                ok: false,
                sourceId,
                sectionId: requestedId,
                error: message
            };
        }

        if (!options.suppressRender) {
            naiNotionController?.renderLibraryPanel?.();
        }
        return syncOutcome;
    }

    function naiNotionStartExternalBulkSync(sourceId) {
        const id = String(sourceId || '');
        const existing = naiNotionBulkJobState(id);
        if (existing?.running) return existing.promise;

        const source = naiNotionGetExternalSources().find(
            row => String(row.id) === id
        );
        const sections = Array.isArray(source?.databases)
            ? [...source.databases]
            : [];

        const state = {
            sourceId: id,
            running: true,
            total: sections.length,
            done: 0,
            success: 0,
            skipped: 0,
            failed: 0,
            activeNames: new Set(),
            sectionStates: new Map(),
            startedAt: Date.now(),
            finishedAt: 0,
            promise: null
        };

        naiNotionExternalBulkJobs.set(id, state);
        naiNotionRefreshBulkSyncViews(id);

        state.promise = (async () => {
            if (!sections.length) {
                state.running = false;
                state.finishedAt = Date.now();
                naiNotionRefreshBulkSyncViews(id);
                return state;
            }

            let cursor = 0;
            const workerCount = Math.min(3, sections.length);

            const worker = async () => {
                while (true) {
                    const index = cursor++;
                    if (index >= sections.length) return;

                    const originalSection = sections[index];
                    const sectionId = String(originalSection.id || '');
                    let latestSource =
                        naiNotionGetExternalSources().find(
                            row => String(row.id) === id
                        );
                    if (!latestSource) return;

                    let section =
                        (latestSource.databases || []).find(
                            row => String(row.id) === sectionId
                        ) ||
                        originalSection;
                    const label = String(
                        section.name || 'Notion 분류'
                    );

                    state.activeNames.add(label);
                    state.sectionStates.set(sectionId, {
                        status: 'running',
                        phase: 'checking'
                    });
                    naiNotionRefreshBulkSyncViews(id);

                    let revisionInfo = {
                        revision: '',
                        skippable: false
                    };
                    try {
                        revisionInfo =
                            await naiNotionCheckExternalSectionRevision(
                                latestSource.url,
                                section
                            );
                    } catch (error) {
                        console.warn(
                            `[${APP_NAME}] external revision check skipped`,
                            label,
                            error
                        );
                    }

                    latestSource =
                        naiNotionGetExternalSources().find(
                            row => String(row.id) === id
                        );
                    section =
                        (latestSource?.databases || []).find(
                            row => String(row.id) === sectionId
                        ) ||
                        section;

                    const canSkip =
                        Boolean(section.lastSync) &&
                        Boolean(section.remoteRevision) &&
                        Boolean(revisionInfo.skippable) &&
                        String(section.remoteRevision) ===
                            String(revisionInfo.revision);

                    if (canSkip) {
                        naiNotionMutateExternalSource(
                            id,
                            current => ({
                                ...current,
                                databases: (current.databases || []).map(
                                    db =>
                                        String(db.id) === sectionId
                                            ? {
                                                ...db,
                                                lastCheckedAt: Date.now(),
                                                error: ''
                                            }
                                            : db
                                )
                            })
                        );

                        state.skipped += 1;
                        state.done += 1;
                        state.activeNames.delete(label);
                        state.sectionStates.set(sectionId, {
                            status: 'skipped'
                        });
                        naiNotionRefreshBulkSyncViews(id);
                        continue;
                    }

                    state.sectionStates.set(sectionId, {
                        status: 'running',
                        phase: 'syncing'
                    });
                    naiNotionRefreshBulkSyncViews(id);

                    const result =
                        await naiNotionSyncExternalSource(
                            id,
                            sectionId,
                            {
                                bulk: true,
                                suppressRender: true,
                                preserveSelection: true,
                                remoteRevision:
                                    revisionInfo.revision || '',
                                revisionSkippable:
                                    Boolean(revisionInfo.skippable)
                            }
                        );

                    if (result?.ok) {
                        state.success += 1;
                        state.sectionStates.set(sectionId, {
                            status: 'success'
                        });
                    } else {
                        state.failed += 1;
                        const reason = String(
                            result?.error || '알 수 없는 오류'
                        )
                            .replace(/\s+/g, ' ')
                            .trim();
                        state.sectionStates.set(sectionId, {
                            status: 'failed',
                            error: reason,
                            shortError:
                                reason.length > 54
                                    ? `${reason.slice(0, 54)}…`
                                    : reason
                        });
                    }

                    state.done += 1;
                    state.activeNames.delete(label);
                    naiNotionRefreshBulkSyncViews(id);
                }
            };

            await Promise.all(
                Array.from(
                    { length: workerCount },
                    () => worker()
                )
            );

            state.running = false;
            state.finishedAt = Date.now();

            naiNotionMutateExternalSource(
                id,
                current => ({
                    ...current,
                    bulkSyncStatus:
                        naiNotionBulkStatusText(state),
                    bulkSyncError: state.failed > 0,
                    bulkSyncFinishedAt: Date.now()
                })
            );

            naiNotionRefreshBulkSyncViews(id);
            naiNotionController?.renderLibraryPanel?.();
            naiNotionToast(
                naiNotionBulkStatusText(state),
                state.failed > 0
            );

            return state;
        })().catch(error => {
            state.running = false;
            state.finishedAt = Date.now();
            state.failed += 1;
            state.activeNames.clear();
            console.error(
                `[${APP_NAME}] external bulk sync failed`,
                error
            );
            naiNotionRefreshBulkSyncViews(id);
            naiNotionToast(
                `전체 동기화 실패 · ${error?.message || String(error)}`,
                true
            );
            return state;
        });

        return state.promise;
    }

    function naiNotionAddExternalModal() {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-external-add';
            overlay.innerHTML = `
                <div class="nai-loader-modal nai-notion-small-modal">
                    <div class="nai-loader-header">
                        <div class="nai-loader-title"><span>Notion 추가</span></div>
                        <button type="button" class="nai-loader-close" data-close>×</button>
                    </div>
                    <div class="nai-loader-content"><div class="nai-loader-panel active">
                        <div class="nai-loader-field">
                            <label class="nai-loader-label">이름</label>
                            <input class="nai-loader-input" data-name placeholder="예: 외형 태그 모음">
                        </div>
                        <div class="nai-loader-field">
                            <label class="nai-loader-label">Notion URL</label>
                            <input class="nai-loader-input" data-url placeholder="https://...notion.site/... 또는 https://app.notion.com/p/...">
                            <div class="nai-loader-muted" style="margin-top:6px;">
                                공개 Notion과 로그인된 게스트 Notion을 링크에서 자동 감지합니다.
                            </div>
                        </div>
                        <div class="nai-edit-footer-actions">
                            <button type="button" class="nai-loader-action" data-cancel>취소</button>
                            <button type="button" class="nai-loader-action primary" data-save>추가</button>
                        </div>
                        <div class="nai-loader-status" data-status></div>
                    </div></div>
                </div>`;

            const finish = value => {
                overlay.remove();
                resolve(value);
            };

            overlay.querySelector('[data-close]').onclick = () => finish(null);
            overlay.querySelector('[data-cancel]').onclick = () => finish(null);
            overlay.querySelector('[data-save]').onclick = () => {
                const name = overlay.querySelector('[data-name]').value.trim();
                const url = normalizedExternalUrl(
                    overlay.querySelector('[data-url]').value.trim()
                );
                let host = '';
                try {
                    host = url ? new URL(url).hostname.toLowerCase() : '';
                } catch (_) {}

                const valid =
                    host === 'app.notion.com' ||
                    host === 'notion.site' ||
                    host.endsWith('.notion.site') ||
                    host === 'notion.so' ||
                    host.endsWith('.notion.so');

                if (!url || !valid) {
                    overlay.querySelector('[data-status]').textContent =
                        'Notion URL을 확인해주세요.';
                    return;
                }

                const accessMode = notionExternalAccessMode(url);
                finish({
                    id:createId(),
                    name:name || (accessMode==='guest'?'게스트 Notion':'외부 Notion'),
                    url,
                    accessMode,
                    items:[],
                    databases:[],
                    selectedDatabaseId:'',
                    lastSync:0,
                    error:''
                });
            };

            document.body.appendChild(overlay);
        });
    }

    function naiNotionExternalDatabaseGroupName(db) {
        const direct = String(db?.groupName || '').trim();
        return direct || '기타';
    }

    function naiNotionExternalDatabaseModal(source) {
        return new Promise(resolve => {
            const latestSource =
                naiNotionGetExternalSources().find(
                    row => String(row.id) === String(source?.id)
                ) ||
                source;
            const databases = Array.isArray(
                latestSource?.databases
            )
                ? latestSource.databases
                : [];
            const selectedId = String(
                latestSource?.selectedDatabaseId ||
                databases[0]?.id ||
                ''
            );

            const groups = [];
            const groupMap = new Map();
            for (const db of databases) {
                const groupName =
                    naiNotionExternalDatabaseGroupName(db);
                if (!groupMap.has(groupName)) {
                    const group = { name: groupName, rows: [] };
                    groupMap.set(groupName, group);
                    groups.push(group);
                }
                groupMap.get(groupName).rows.push(db);
            }

            const bulkState =
                naiNotionBulkJobState(latestSource?.id);

            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-external-db-picker';
            overlay.innerHTML = `
                <div class="nai-loader-modal nai-notion-small-modal">
                    <div class="nai-loader-header">
                        <div class="nai-loader-title"><span>${escapeHtml(latestSource?.name || '외부 Notion')} · 분류 선택</span></div>
                        <button type="button" class="nai-loader-close" data-close>×</button>
                    </div>
                    <div class="nai-loader-content"><div class="nai-loader-panel active">
                        <div class="nai-notion-external-bulk-sync"
                             data-nn-bulk-source="${escapeHtml(latestSource?.id || '')}">
                            <button type="button"
                                    class="nai-loader-action primary"
                                    data-sync-all
                                    ${(!databases.length || bulkState?.running) ? 'disabled' : ''}>${bulkState?.running ? '전체 동기화 중…' : '전체 동기화'}</button>
                            <span class="nai-notion-inline-status ${bulkState && !bulkState.running && bulkState.failed ? 'error' : ''}"
                                  data-sync-all-status>${escapeHtml(naiNotionBulkStatusText(bulkState))}</span>
                        </div>
                        <div class="nai-notion-external-db-list">
                            ${databases.length
                                ? groups.map(group => `
                                    <section class="nai-notion-external-db-group">
                                        <div class="nai-notion-external-db-group-title">${escapeHtml(group.name)}</div>
                                        <div class="nai-notion-external-db-group-rows">
                                            ${group.rows.map(db => `
                                                <button type="button"
                                                    class="nai-notion-external-db-choice ${String(db.id) === selectedId ? 'active' : ''}"
                                                    data-db-id="${escapeHtml(db.id)}">
                                                    <span>
                                                        <strong>${escapeHtml(db.name || 'Notion 분류')}</strong>
                                                        <small data-db-meta="${escapeHtml(db.id)}">${db.lastSync ? `캐시 ${Array.isArray(db.items) ? db.items.length : 0}개 · ${new Date(db.lastSync).toLocaleString()}` : '동기화 전'}</small>
                                                    </span>
                                                    <span>›</span>
                                                </button>`).join('')}
                                        </div>
                                    </section>`).join('')
                                : '<div class="nai-loader-muted">아직 발견된 분류가 없습니다. 외부 소스의 동기화 버튼을 먼저 눌러주세요.</div>'}
                        </div>
                    </div></div>
                </div>`;

            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                overlay.remove();
                resolve(value);
            };

            overlay.querySelector('[data-close]').onclick =
                () => finish(null);

            const syncAllButton =
                overlay.querySelector('[data-sync-all]');
            if (syncAllButton) {
                syncAllButton.onclick = () => {
                    if (!databases.length) return;

                    // Do not await. The sync job lives independently from this
                    // picker, so closing the window never pauses/cancels it.
                    naiNotionStartExternalBulkSync(
                        latestSource.id
                    );
                    naiNotionRefreshBulkSyncViews(
                        latestSource.id
                    );
                };
            }

            overlay.addEventListener('mousedown', event => {
                if (event.target === overlay) finish(null);
            });

            overlay.addEventListener('click', event => {
                const button =
                    event.target.closest('[data-db-id]');
                if (!button) return;

                const id = String(button.dataset.dbId || '');
                const currentSource =
                    naiNotionGetExternalSources().find(
                        row =>
                            String(row.id) ===
                            String(latestSource.id)
                    );
                const currentDatabases =
                    Array.isArray(currentSource?.databases)
                        ? currentSource.databases
                        : databases;

                finish(
                    currentDatabases.find(
                        db => String(db.id) === id
                    ) ||
                    null
                );
            });

            document.body.appendChild(overlay);
            naiNotionRefreshBulkSyncViews(
                latestSource?.id
            );
        });
    }

    async function naiNotionChoosePersonalArchive() {
        const token = await naiNotionGetTokenInteractive();
        if (!token) return null;

        const current = naiNotionGetConnection();
        let archives = naiNotionVisiblePersonalArchives();

        // If the user has never configured visibility, keep the current/legacy
        // stores available. If the list is genuinely empty, open the account
        // manager so the user can choose what should appear.
        if (!archives.length) {
            const managed = await naiNotionDatabaseManagerModal(token, {
                refreshOnOpen: true
            });
            if (!managed) return null;
            archives = naiNotionVisiblePersonalArchives();
        }

        const rootPageId =
            current.rootPageId ||
            String(GM_getValue(NAI_NOTION.rootPageKey, '') || '');

        const chosen = await naiNotionChoiceModal(
            archives,
            rootPageId,
            token
        );
        if (!chosen) return null;

        const previous = naiNotionGetConnection();
        naiNotionSaveConnection(chosen);
        naiNotionState.personalCategory = '';

        if (previous.dataSourceId !== chosen.dataSourceId) {
            naiNotionState.cache = naiNotionLoadCache(chosen.dataSourceId);
        }

        // Switching libraries is cache-only and instant. The refresh button owns network sync.
        naiNotionController?.renderLibraryPanel?.();
        const cachedCount = (naiNotionCurrentCache().items || []).length;
        naiNotionSetLibraryStatus(
            `“${chosen.title || 'Notion DB'}”로 전환 · 캐시 ${cachedCount}개${cachedCount ? '' : ' · 필요하면 ↻ 동기화'}`
        );
        return chosen;
    }

    function naiNotionOpenCurrentDatabase() {
        const url = naiNotionGetConnection().databaseUrl;
        if (!url) return false;
        try { GM_openInTab(url, { active: true, insert: true, setParent: true }); }
        catch (_) { window.open(url, '_blank', 'noopener,noreferrer'); }
        return true;
    }

    function naiNotionLibraryModeHeader(panel) {
        let header = panel.querySelector('[data-nai-notion-library-modes]');
        if (!header) {
            header = document.createElement('div');
            header.dataset.naiNotionLibraryModes = '1';
            header.className = 'nai-notion-library-modes';
            const toolbar = panel.querySelector('.nai-library-toolbar');
            panel.insertBefore(header, toolbar || panel.firstChild);
        }
        const connection = naiNotionGetConnection();
        const archiveLabel = connection.title || (connection.dataSourceId ? `저장소 ${connection.dataSourceId.slice(0, 6)}…` : '저장소 선택');
        const personalLegacyView =
            naiNotionState.mode === 'personal' &&
            naiNotionState.legacyExternalView &&
            getLibrary().length > 0;

        header.innerHTML = `
            <div class="nai-notion-mode-tabs">
                <button type="button" class="nai-loader-action ${naiNotionState.mode === 'personal' ? 'primary' : ''}" data-nn-mode="personal">내 라이브러리</button>
                <button type="button" class="nai-loader-action ${naiNotionState.mode === 'external' ? 'primary' : ''}" data-nn-mode="external">외부 라이브러리</button>
            </div>
            <div class="nai-notion-mode-actions">
                ${personalLegacyView
                    ? `<span class="nai-notion-legacy-heading">기존 라이브러리</span><button type="button" class="nai-loader-action primary" data-nn-legacy="backup">Notion으로 모두 백업</button><button type="button" class="nai-loader-action" data-nn-legacy="back">Notion으로 돌아가기</button>`
                    : (naiNotionState.mode === 'personal'
                        ? `<button type="button" class="nai-loader-action" data-nn-archive-menu title="개인 Notion 저장소 바꾸기">${escapeHtml(archiveLabel)} ▾</button><button type="button" class="nai-loader-action" data-nn-refresh title="현재 저장소 동기화">↻</button><button type="button" class="nai-loader-action" data-nn-open-personal ${connection.databaseUrl ? '' : 'disabled'}>Notion에서 열기</button>`
                        : '')}
            </div>`;
        return header;
    }

    function naiNotionPersonalItemsFiltered() {
        const panel = document.querySelector(`#${MODAL_ID} [data-panel="library"]`);
        const query = String(panel?.querySelector('#nai-library-search')?.value || '').trim().toLowerCase();
        const category = naiNotionState.personalCategory;
        return (naiNotionCurrentCache().items || []).filter(item => {
            if (category && !(item.categories || []).includes(category)) return false;
            if (naiNotionState.personalFavoritesOnly && !naiNotionIsFavorite(item)) return false;
            if (!query) return true;
            return [item.name, item.tags, item.negativeTags, item.note, ...(item.characters || []).flatMap(x => [x.name, x.prompt, x.negativePrompt])]
                .filter(Boolean).some(v => String(v).toLowerCase().includes(query));
        });
    }

    function naiNotionRenderPersonal(panel) {
        const toolbar = panel.querySelector('.nai-library-toolbar');
        const add = toolbar?.querySelector('[data-create-toggle="library"]');
        if (add) add.hidden = true;
        const createWrap = panel.querySelector('#nai-library-create-wrap');
        if (createWrap) createWrap.hidden = true;
        const search = panel.querySelector('#nai-library-search');
        if (search) search.placeholder = 'Notion 라이브러리 검색';
        const categoryBar = panel.querySelector('#nai-library-category-bar');
        const list = panel.querySelector('#nai-library-list');
        const token = naiNotionReadToken();
        const connection = naiNotionGetConnection();
        if (!token || !connection.dataSourceId) {
            if (categoryBar) categoryBar.innerHTML = '';
            if (list) list.innerHTML = `<div class="nai-notion-connect-empty"><strong>Notion 라이브러리가 연결되지 않았습니다.</strong><span>NAI Archive는 자신의 Notion을 프롬프트 저장소로 사용할 수 있습니다.</span><button type="button" class="nai-loader-action primary" data-nn-connect>Notion 연결</button></div>`;
            return;
        }
        const cache = naiNotionCurrentCache();
        const categories = normalizeLibraryCategoryList((cache.items || []).flatMap(x => x.categories || []));
        const legacyCount = getLibrary().length;
        const legacyIcon = legacyCount
            ? `<button type="button" class="nai-notion-legacy-icon" data-nn-legacy="open" title="기존 로컬 라이브러리 ${legacyCount}개" aria-label="기존 로컬 라이브러리 열기">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M4.5 7.5h15v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z"></path>
                        <path d="M3.5 4.5h17v3h-17z"></path>
                        <path d="M9.5 11.5h5"></path>
                    </svg>
               </button>`
            : '';
        if (categoryBar) categoryBar.innerHTML = `<button type="button" class="nai-category-chip ${(!naiNotionState.personalCategory && !naiNotionState.legacyExternalView) ? 'active' : ''}" data-nn-category="">Notion</button>${legacyIcon}${categories.map(name => `<button type="button" class="nai-category-chip ${naiNotionState.personalCategory === name && !naiNotionState.legacyExternalView ? 'active' : ''}" data-nn-category="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join('')}<button type="button" class="nai-notion-favorite-filter ${naiNotionState.personalFavoritesOnly ? 'active' : ''}" data-nn-favorite-filter="personal" title="${naiNotionState.personalFavoritesOnly ? '즐겨찾기만 보기 해제' : '즐겨찾기만 보기'}" aria-label="즐겨찾기만 보기" aria-pressed="${naiNotionState.personalFavoritesOnly ? 'true' : 'false'}">${naiNotionFavoriteIcon()}</button>`;
        const items = naiNotionPersonalItemsFiltered();
        if (!items.length) {
            list.innerHTML = `<div class="nai-library-empty">${cache.items?.length ? '검색 결과가 없습니다.' : 'Notion NAI Archive에 아직 저장된 항목이 없습니다.'}</div>`;
            return;
        }
        list.innerHTML = `<div class="nai-notion-gallery">${items.map(item => `
            <article class="nai-notion-card" data-nn-page="${escapeHtml(item._notionPageId || item.id)}">
                <button type="button" class="nai-notion-card-favorite ${naiNotionIsFavorite(item) ? 'active' : ''}" data-nn-favorite-item="personal" data-nn-id="${escapeHtml(item._notionPageId || item.id)}" title="${naiNotionIsFavorite(item) ? '즐겨찾기 해제' : '즐겨찾기'}" aria-label="${naiNotionIsFavorite(item) ? '즐겨찾기 해제' : '즐겨찾기'}" aria-pressed="${naiNotionIsFavorite(item) ? 'true' : 'false'}">${naiNotionFavoriteIcon()}</button>
                <button type="button" class="nai-notion-card-image" data-nn-detail="${escapeHtml(item._notionPageId || item.id)}">
                    ${item._notionImageUrl ? `<img data-nn-thumb="${escapeHtml(item._notionPageId || item.id)}" alt="">` : '<span class="nai-notion-no-image">No image</span>'}
                </button>
                <div class="nai-notion-card-body">
                    <button type="button" class="nai-notion-card-title" data-nn-detail="${escapeHtml(item._notionPageId || item.id)}">${escapeHtml(item.name)}</button>
                    <div class="nai-notion-card-cats">${(item.categories || []).map(x => `<span>${escapeHtml(x)}</span>`).join('')}</div>
                    ${item.tags ? (() => {
                        const mode = naiNotionGetPersonalBaseMode(item);
                        const id = escapeHtml(item._notionPageId || item.id);
                        return `<div class="nai-notion-card-pref"><span>Base</span><div class="nai-notion-segment"><button type="button" class="${mode === 'append' ? 'active' : ''}" data-nn-personal-base-mode="append" data-nn-id="${id}">뒤에 추가</button><button type="button" class="${mode === 'replace' ? 'active' : ''}" data-nn-personal-base-mode="replace" data-nn-id="${id}">교체</button></div></div>`;
                    })() : ''}
                    ${(() => {
                        const id = escapeHtml(item._notionPageId || item.id);
                        const active = naiNotionReferenceIsItemActive(item);
                        return `<div class="nai-notion-card-pref nai-notion-reference-row"><span>Reference</span><div class="nai-notion-segment"><button type="button" class="${active ? 'active' : ''}" data-nn-reference-toggle="on" data-nn-id="${id}">ON</button><button type="button" class="${active ? '' : 'active'}" data-nn-reference-toggle="off" data-nn-id="${id}">OFF</button></div></div>`;
                    })()}
                    <div class="nai-notion-card-actions"><button type="button" class="nai-loader-action nai-notion-reference-icon ${naiNotionReferenceIsItemActive(item) ? 'active' : ''}" data-nn-reference-image data-nn-id="${escapeHtml(item._notionPageId || item.id)}" title="로컬 레퍼런스 이미지 선택" aria-label="로컬 레퍼런스 이미지 선택"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m6 17 4-4 3 3 2-2 3 3"></path></svg></button><button type="button" class="nai-loader-action" data-nn-action="copy" data-nn-id="${escapeHtml(item._notionPageId || item.id)}">복사</button><button type="button" class="nai-loader-action primary" data-nn-action="use" data-nn-id="${escapeHtml(item._notionPageId || item.id)}">사용</button></div>
                </div>
            </article>`).join('')}</div>`;
        requestAnimationFrame(() => {
            list.querySelectorAll('[data-nn-thumb]').forEach(img => {
                const item = items.find(x => (x._notionPageId || x.id) === img.dataset.nnThumb);
                if (item) naiNotionHydrateThumbnail(img, item);
            });
        });
        if (!cache.lastSync) naiNotionSyncPersonal({ quiet: true }).catch(() => {});
    }

    function naiNotionRenderExternal(panel) {
        const toolbar=panel.querySelector('.nai-library-toolbar');
        const add=toolbar?.querySelector('[data-create-toggle="library"]'); if(add)add.hidden=true;
        const createWrap=panel.querySelector('#nai-library-create-wrap'); if(createWrap)createWrap.hidden=true;
        const search=panel.querySelector('#nai-library-search'); if(search)search.placeholder='외부 라이브러리 검색';
        const categoryBar=panel.querySelector('#nai-library-category-bar'); if(categoryBar)categoryBar.innerHTML='';
        const list=panel.querySelector('#nai-library-list');
        const sources=naiNotionGetExternalSources();
        const selected=naiNotionState.externalSourceId ? sources.find(x=>x.id===naiNotionState.externalSourceId) : null;
        const selectedDatabases=Array.isArray(selected?.databases)?selected.databases:[];
        const activeDatabase=selectedDatabases.find(db=>String(db.id)===String(selected?.selectedDatabaseId||'')) || selectedDatabases[0] || null;
        const sourceCards=sources.map(source=>{const dbs=Array.isArray(source.databases)?source.databases:[];return `
          <div class="nai-notion-external-source" data-nn-source="${escapeHtml(source.id)}">
            <div class="nai-notion-external-source-top">
                <strong>${escapeHtml(source.name)}</strong>
                <div class="nai-notion-external-actions"><button type="button" class="nai-loader-action nai-notion-sync-icon" data-nn-ext="sync" data-nn-source-id="${escapeHtml(source.id)}" title="${source.lastSync?'다시 동기화':'처음 동기화'}" aria-label="${source.lastSync?'다시 동기화':'동기화'}">${source.lastSync?'↻':'동기화'}</button><button type="button" class="nai-loader-action" data-nn-ext="open" data-nn-source-id="${escapeHtml(source.id)}">원본 열기</button><button type="button" class="nai-loader-action danger" data-nn-ext="remove" data-nn-source-id="${escapeHtml(source.id)}">삭제</button></div>
            </div>
            <div class="nai-notion-external-source-bottom">
                <span class="nai-notion-external-meta">${notionExternalAccessMode(source.url)==='guest'?'게스트 · ':''}${source.lastSync?new Date(source.lastSync).toLocaleString():'동기화 전'}${dbs.length?` · 분류 ${dbs.length}개`:''}</span>
                <span class="nai-notion-external-inline-status ${(source.syncStatusError||source.error)?'error':''}" data-nn-ext-status ${!(source.syncStatus||source.error)?'hidden':''}>${escapeHtml(source.syncStatus || source.error || '')}</span>
            </div>
          </div>`;}).join('');
        const query=String(search?.value||'').trim().toLowerCase();
        const sourceItems=activeDatabase?(Array.isArray(activeDatabase.items)?activeDatabase.items:[]):(selected?(selected.items||[]):[]);
        const items=sourceItems.filter(item=>{
            if(naiNotionState.externalFavoritesOnly && !naiNotionIsFavorite(item)) return false;
            return !query || [item.name,item.tags,item.negativeTags,item.note].some(v=>String(v||'').toLowerCase().includes(query));
        });
        const activeDbGroup = activeDatabase
            ? naiNotionExternalDatabaseGroupName(activeDatabase)
            : '';
        const activeDbLabel = activeDatabase
            ? `${activeDbGroup && activeDbGroup !== '기타' ? `${activeDbGroup} · ` : ''}${activeDatabase.name || 'Notion DB'}`
            : (selectedDatabases.length ? '분류 선택' : '분류 찾기 전');
        const externalPrefs = naiNotionExternalApplyPrefs(selected, activeDatabase);
        list.innerHTML=`
          <div class="nai-notion-external-manager">${sourceCards || '<div class="nai-loader-muted">등록된 외부 Notion이 없습니다.</div>'}<div class="nai-notion-external-bottom"><button type="button" class="nai-loader-action primary" data-nn-ext="add">+ Notion 추가</button></div></div>
          ${sources.length?`<div class="nai-loader-divider"></div><div class="nai-notion-source-tabs">${sources.map(s=>`<button type="button" class="nai-loader-action ${selected?.id===s.id?'primary':''}" data-nn-ext="select" data-nn-source-id="${escapeHtml(s.id)}">${escapeHtml(s.name)}</button>`).join('')}<button type="button" class="nai-notion-favorite-filter ${naiNotionState.externalFavoritesOnly?'active':''}" data-nn-favorite-filter="external" title="${naiNotionState.externalFavoritesOnly?'즐겨찾기만 보기 해제':'즐겨찾기만 보기'}" aria-label="즐겨찾기만 보기" aria-pressed="${naiNotionState.externalFavoritesOnly?'true':'false'}">${naiNotionFavoriteIcon()}</button></div>`:''}
          ${selected?`<div class="nai-notion-external-db-toolbar"><button type="button" class="nai-loader-action" data-nn-ext="choose-db" data-nn-source-id="${escapeHtml(selected.id)}">${escapeHtml(activeDbLabel)} ▾</button>${activeDatabase?`<button type="button" class="nai-loader-action nai-notion-sync-icon" data-nn-ext="sync-db" data-nn-source-id="${escapeHtml(selected.id)}" data-nn-db-id="${escapeHtml(activeDatabase.id)}" title="${activeDatabase.lastSync?'이 분류 다시 동기화':'이 분류 동기화'}">↻</button>`:''}${selectedDatabases.length?`<span class="nai-loader-muted">분류 ${selectedDatabases.length}개</span>`:`<span class="nai-loader-muted">↻ 동기화하면 이 Notion의 분류 목록을 찾습니다.</span>`}
                <div class="nai-notion-external-apply-prefs">
                    <span class="nai-notion-pref-label">적용 위치</span>
                    <div class="nai-notion-segment">
                        <button type="button" class="${externalPrefs.target==='base'?'active':''}" data-nn-ext-pref="applyTarget" data-value="base" data-nn-source-id="${escapeHtml(selected.id)}" data-nn-db-id="${escapeHtml(activeDatabase?.id || '')}">Base Prompt</button>
                        <button type="button" class="${externalPrefs.target==='character'?'active':''}" data-nn-ext-pref="applyTarget" data-value="character" data-nn-source-id="${escapeHtml(selected.id)}" data-nn-db-id="${escapeHtml(activeDatabase?.id || '')}">Character Prompt</button>
                    </div>
                    <span class="nai-notion-pref-label ${externalPrefs.target==='character'?'disabled':''}">Base 방식</span>
                    <div class="nai-notion-segment ${externalPrefs.target==='character'?'disabled':''}">
                        <button type="button" class="${externalPrefs.baseMode==='append'?'active':''}" data-nn-ext-pref="baseMode" data-value="append" data-nn-source-id="${escapeHtml(selected.id)}" data-nn-db-id="${escapeHtml(activeDatabase?.id || '')}" ${externalPrefs.target==='character'?'disabled':''}>뒤에 추가</button>
                        <button type="button" class="${externalPrefs.baseMode==='replace'?'active':''}" data-nn-ext-pref="baseMode" data-value="replace" data-nn-source-id="${escapeHtml(selected.id)}" data-nn-db-id="${escapeHtml(activeDatabase?.id || '')}" ${externalPrefs.target==='character'?'disabled':''}>교체</button>
                    </div>
                </div>
          </div>`:''}
          ${selected?(items.length?`<div class="nai-notion-gallery nai-notion-external-gallery">${items.map(item=>`<article class="nai-notion-card" data-nn-ext-item="${escapeHtml(item.id)}"><button type="button" class="nai-notion-card-favorite ${naiNotionIsFavorite(item)?'active':''}" data-nn-favorite-item="external" data-nn-id="${escapeHtml(item.id)}" title="${naiNotionIsFavorite(item)?'즐겨찾기 해제':'즐겨찾기'}" aria-label="${naiNotionIsFavorite(item)?'즐겨찾기 해제':'즐겨찾기'}" aria-pressed="${naiNotionIsFavorite(item)?'true':'false'}">${naiNotionFavoriteIcon()}</button>${item._notionImageUrl?`<button type="button" class="nai-notion-card-image" data-nn-ext-detail="${escapeHtml(item.id)}"><img src="${escapeHtml(item._notionImageUrl)}" data-notion-src="${escapeHtml(item._notionImageUrl)}" alt="" loading="lazy"></button>`:'<div class="nai-notion-card-image nai-notion-card-image-empty"><span class="nai-notion-no-image">No image</span></div>'}<div class="nai-notion-card-body"><button type="button" class="nai-notion-card-title" data-nn-ext-detail="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button><div class="nai-notion-card-cats">${(item.categories||[]).map(x=>`<span>${escapeHtml(x)}</span>`).join('')}</div>${(()=>{const active=naiNotionReferenceIsItemActive(item);return `<div class="nai-notion-card-pref nai-notion-reference-row"><span>Reference</span><div class="nai-notion-segment"><button type="button" class="${active?'active':''}" data-nn-ext-reference-toggle="on" data-nn-id="${escapeHtml(item.id)}">ON</button><button type="button" class="${active?'':'active'}" data-nn-ext-reference-toggle="off" data-nn-id="${escapeHtml(item.id)}">OFF</button></div></div>`;})()}<div class="nai-notion-card-actions"><button type="button" class="nai-loader-action nai-notion-reference-icon ${naiNotionReferenceIsItemActive(item)?'active':''}" data-nn-ext-reference-image data-nn-id="${escapeHtml(item.id)}" title="로컬 레퍼런스 이미지 선택" aria-label="로컬 레퍼런스 이미지 선택"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="17" height="16" rx="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m6 17 4-4 3 3 2-2 3 3"></path></svg></button><button type="button" class="nai-loader-action" data-nn-ext-action="copy" data-nn-id="${escapeHtml(item.id)}">복사</button><button type="button" class="nai-loader-action primary" data-nn-ext-action="use" data-nn-id="${escapeHtml(item.id)}">사용</button></div></div></article>`).join('')}</div>`:`<div class="nai-library-empty">${activeDatabase&&!activeDatabase.lastSync?'이 분류는 아직 동기화하지 않았습니다. ↻을 눌러주세요.':'캐시된 항목이 없습니다.'}</div>`):''}`;
    }

    function naiNotionExternalDetailModal(item) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-external-detail-modal';
            const characters = normalizeCharacterRows(item.characters);
            const characterPromptText = naiNotionFormatCharacters(characters, 'prompt');
            const characterNegativeText = naiNotionFormatCharacters(characters, 'negative');
            const sourceUrl = item?.source?.url || item?.source?.rootUrl || '';
            const referenceActive = naiNotionReferenceIsItemActive(item);
            overlay.innerHTML = `<div class="nai-loader-modal nai-notion-detail-modal"><div class="nai-loader-header"><div class="nai-loader-title"><span>${escapeHtml(item.name)}</span></div><button type="button" class="nai-loader-close" data-close>×</button></div><div class="nai-loader-content"><div class="nai-loader-panel active"><div class="nai-notion-detail-image">${item._notionImageUrl ? `<img src="${escapeHtml(item._notionImageUrl)}" data-notion-src="${escapeHtml(item._notionImageUrl)}" alt="">` : ''}</div><div class="nai-loader-field"><label class="nai-loader-label">Name</label><input class="nai-loader-input" value="${escapeHtml(item.name)}" readonly></div><div class="nai-loader-field"><label class="nai-loader-label">Categories</label><input class="nai-loader-input" value="${escapeHtml((item.categories||[]).join(', '))}" readonly></div><div class="nai-loader-field"><label class="nai-loader-label">Base Prompt</label><textarea class="nai-loader-textarea" readonly>${escapeHtml(item.tags||'')}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Undesired Content</label><textarea class="nai-loader-textarea" readonly>${escapeHtml(item.negativeTags||'')}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Character Prompt</label><textarea class="nai-loader-textarea" readonly>${escapeHtml(characterPromptText)}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Character Negative / UC</label><textarea class="nai-loader-textarea" readonly>${escapeHtml(characterNegativeText)}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Memo</label><textarea class="nai-loader-textarea" readonly>${escapeHtml(item.note||'')}</textarea></div><div class="nai-edit-footer-actions nai-notion-external-detail-footer"><span class="nai-notion-inline-status" data-status></span><button type="button" class="nai-loader-action nai-notion-reference-text ${referenceActive ? 'active' : ''}" data-action="reference" title="레퍼런스 설정${referenceActive ? ' · ON' : ''}">레퍼런스</button>${sourceUrl ? '<button type="button" class="nai-loader-action" data-action="source">원본 열기</button>' : ''}</div></div></div></div>`;
            const close = () => { overlay.remove(); resolve(); };
            overlay.querySelector('[data-close]').onclick = close;
            overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
            const status = overlay.querySelector('[data-status]');
            overlay.addEventListener('click', async event => {
                const button = event.target.closest('[data-action]');
                if (!button) return;
                const action = button.dataset.action;
                if (action === 'reference') {
                    const result = await naiNotionReferenceModal(item);
                    if (result) {
                        button.classList.toggle('active', Boolean(result.enabled));
                        button.title = `레퍼런스 설정${result.enabled ? ' · ON' : ''}`;
                        if (status) status.textContent = result.enabled ? '레퍼런스 ON.' : '레퍼런스 OFF.';
                        naiNotionController?.renderLibraryPanel?.();
                    }
                } else if (action === 'source' && sourceUrl) {
                    window.open(sourceUrl, '_blank', 'noopener,noreferrer');
                }
            });
            document.body.appendChild(overlay);
        });
    }

    function naiNotionConfirmModal({
        title = '확인',
        message = '',
        confirmText = '확인',
        cancelText = '취소',
        danger = false
    } = {}) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay nai-notion-confirm-overlay';
            overlay.innerHTML = `
                <div class="nai-loader-modal nai-notion-small-modal nai-notion-confirm-modal">
                    <div class="nai-loader-header">
                        <div class="nai-loader-title"><span>${escapeHtml(title)}</span></div>
                        <button type="button" class="nai-loader-close" data-confirm-close>×</button>
                    </div>
                    <div class="nai-loader-content">
                        <div class="nai-loader-panel active">
                            <div class="nai-notion-confirm-message">${escapeHtml(message).replace(/\n/g, '<br>')}</div>
                            <div class="nai-notion-confirm-actions">
                                <button type="button" class="nai-loader-action" data-confirm-cancel>${escapeHtml(cancelText)}</button>
                                <button type="button" class="nai-loader-action ${danger ? 'danger' : 'primary'}" data-confirm-ok>${escapeHtml(confirmText)}</button>
                            </div>
                        </div>
                    </div>
                </div>`;

            const finish = value => {
                overlay.remove();
                resolve(Boolean(value));
            };

            overlay.querySelector('[data-confirm-close]').onclick = () => finish(false);
            overlay.querySelector('[data-confirm-cancel]').onclick = () => finish(false);
            overlay.querySelector('[data-confirm-ok]').onclick = () => finish(true);
            overlay.addEventListener('mousedown', event => {
                if (event.target === overlay) finish(false);
            });

            document.body.appendChild(overlay);
        });
    }

    /* ---------------------------------------------------------------------
     * Personal library · Precise Reference
     * One active reference at a time. Image bytes live in IndexedDB so the
     * setting survives reloads without bloating Tampermonkey's value store.
     * --------------------------------------------------------------------- */
    const NAI_PRECISE_REFERENCE_DB = 'naiConceptLoader.preciseReferenceV1';
    const NAI_PRECISE_REFERENCE_STORE = 'active';
    let naiPreciseReferenceDbPromise = null;

    function naiNotionReferenceItemId(item) {
        const baseId = String(item?._notionPageId || item?.id || '');
        if (!baseId) return '';
        if (item?._externalSourceId) {
            return `external:${String(item._externalSourceId)}:${String(item._externalDatabaseId || '')}:${baseId}`;
        }
        return baseId;
    }

    function naiNotionNormalizeReferenceType(value) {
        return 'character&style';
    }

    function naiNotionReferenceNumber(value, fallback = 1) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function naiNotionReferenceSnap(value, fallback = 1) {
        const normalized = Math.max(0, Math.min(1, naiNotionReferenceNumber(value, fallback)));
        return Math.max(0, Math.min(1, Number((Math.round(normalized / 0.05) * 0.05).toFixed(2))));
    }

    function naiNotionGetReferencePreset(item) {
        const id = naiNotionReferenceItemId(item);
        const map = GM_getValue(NAI_NOTION.referencePresetMapKey, {});
        const saved = map && typeof map === 'object' ? map[id] : null;
        return {
            type: 'character&style',
            strength: naiNotionReferenceSnap(saved?.strength, 1),
            fidelity: naiNotionReferenceSnap(saved?.fidelity, 1)
        };
    }

    function naiNotionSaveReferencePreset(item, preset) {
        const id = naiNotionReferenceItemId(item);
        if (!id) return;
        const raw = GM_getValue(NAI_NOTION.referencePresetMapKey, {});
        const map = raw && typeof raw === 'object' ? { ...raw } : {};
        map[id] = {
            type: 'character&style',
            strength: naiNotionReferenceSnap(preset?.strength, 1),
            fidelity: naiNotionReferenceSnap(preset?.fidelity, 1)
        };
        GM_setValue(NAI_NOTION.referencePresetMapKey, map);
    }

    function naiNotionGetActiveReference() {
        const saved = GM_getValue(NAI_NOTION.activeReferenceKey, null);
        if (!saved || typeof saved !== 'object' || !saved.enabled || !saved.itemId) return null;
        return {
            ...saved,
            itemId: String(saved.itemId),
            type: 'character&style',
            strength: naiNotionReferenceSnap(saved.strength, 1),
            fidelity: naiNotionReferenceSnap(saved.fidelity, 1),
            cacheSecretKey: String(saved.cacheSecretKey || '')
        };
    }

    function naiNotionReferenceIsItemActive(item) {
        const active = naiNotionGetActiveReference();
        return Boolean(active && active.itemId === naiNotionReferenceItemId(item));
    }

    function naiNotionOpenPreciseReferenceDb() {
        if (naiPreciseReferenceDbPromise) return naiPreciseReferenceDbPromise;
        naiPreciseReferenceDbPromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(NAI_PRECISE_REFERENCE_DB, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(NAI_PRECISE_REFERENCE_STORE)) {
                    db.createObjectStore(NAI_PRECISE_REFERENCE_STORE, { keyPath: 'key' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Reference 저장소를 열 수 없습니다.'));
        });
        return naiPreciseReferenceDbPromise;
    }

    async function naiNotionReferenceDbPut(record) {
        const db = await naiNotionOpenPreciseReferenceDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readwrite');
            tx.objectStore(NAI_PRECISE_REFERENCE_STORE).put({ key: 'active', ...record });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Reference 저장에 실패했습니다.'));
        });
    }

    async function naiNotionReferenceDbGet() {
        const db = await naiNotionOpenPreciseReferenceDb();
        const record = await new Promise((resolve, reject) => {
            const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readonly');
            const request = tx.objectStore(NAI_PRECISE_REFERENCE_STORE).get('active');
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('Reference를 읽지 못했습니다.'));
        });
        return await naiNotionReferenceMigrateLegacyActive(record);
    }

    async function naiNotionReferenceDbPutItem(itemId, record) {
        const id = String(itemId || '');
        if (!id) throw new Error('Reference 카드 ID를 찾지 못했습니다.');
        const db = await naiNotionOpenPreciseReferenceDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readwrite');
            tx.objectStore(NAI_PRECISE_REFERENCE_STORE).put({ key: `item:${id}`, itemId: id, ...record });
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('Reference 이미지 저장에 실패했습니다.'));
        });
    }

    async function naiNotionReferenceDbGetItem(itemId) {
        const id = String(itemId || '');
        if (!id) return null;
        const db = await naiNotionOpenPreciseReferenceDb();
        const record = await new Promise((resolve, reject) => {
            const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readonly');
            const request = tx.objectStore(NAI_PRECISE_REFERENCE_STORE).get(`item:${id}`);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error || new Error('Reference 이미지를 읽지 못했습니다.'));
        });
        return await naiNotionReferenceNormalizeStoredItem(record);
    }

    async function naiNotionReferenceDbClear() {
        try {
            const db = await naiNotionOpenPreciseReferenceDb();
            await new Promise(resolve => {
                const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readwrite');
                tx.objectStore(NAI_PRECISE_REFERENCE_STORE).delete('active');
                tx.oncomplete = resolve;
                tx.onerror = resolve;
            });
        } catch (_) {}
    }

    function naiNotionBlobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const value = String(reader.result || '');
                const comma = value.indexOf(',');
                resolve(comma >= 0 ? value.slice(comma + 1) : value);
            };
            reader.onerror = () => reject(reader.error || new Error('Reference 이미지 변환에 실패했습니다.'));
            reader.readAsDataURL(blob);
        });
    }

    function naiNotionReferenceCacheSecret() {
        const bytes = new Uint8Array(32);
        const cryptoObject = PAGE_WINDOW.crypto || globalThis.crypto;
        if (cryptoObject?.getRandomValues) cryptoObject.getRandomValues(bytes);
        else {
            for (let index = 0; index < bytes.length; index += 1) {
                bytes[index] = Math.floor(Math.random() * 256);
            }
        }
        return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function naiNotionReferenceCacheSecretFromBase64(base64) {
        try {
            const binary = atob(String(base64 || ''));
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            const cryptoObject = PAGE_WINDOW.crypto || globalThis.crypto;
            if (!cryptoObject?.subtle?.digest) return naiNotionReferenceCacheSecret();
            const digest = new Uint8Array(await cryptoObject.subtle.digest('SHA-256', bytes));
            return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            return naiNotionReferenceCacheSecret();
        }
    }

    function naiNotionReferenceBase64Blob(base64, mime = 'image/png') {
        const binary = atob(String(base64 || ''));
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        const BlobCtor = PAGE_WINDOW.Blob || Blob;
        return new BlobCtor([bytes], { type: mime || 'image/png' });
    }


    async function naiNotionReferenceCacheSecretFromBlob(blob) {
        try {
            if (!blob || typeof blob.arrayBuffer !== 'function') return naiNotionReferenceCacheSecret();
            const bytes = await blob.arrayBuffer();
            const cryptoObject = PAGE_WINDOW.crypto || globalThis.crypto;
            if (!cryptoObject?.subtle?.digest) return naiNotionReferenceCacheSecret();
            const digest = new Uint8Array(await cryptoObject.subtle.digest('SHA-256', bytes));
            return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            return naiNotionReferenceCacheSecret();
        }
    }

    async function naiNotionReferenceNormalizeStoredItem(record) {
        if (!record) return null;
        if (record.blob && typeof record.blob.arrayBuffer === 'function') return record;
        if (!record.base64) return record;
        try {
            const blob = naiNotionReferenceBase64Blob(record.base64, record.mime || 'image/png');
            const migrated = { ...record, blob };
            delete migrated.base64;
            const db = await naiNotionOpenPreciseReferenceDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readwrite');
                tx.objectStore(NAI_PRECISE_REFERENCE_STORE).put(migrated);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error || new Error('Reference 이미지 마이그레이션에 실패했습니다.'));
            });
            return migrated;
        } catch (_) {
            return record;
        }
    }

    async function naiNotionReferenceMigrateLegacyActive(record) {
        if (!record?.base64 || !record?.itemId) return record;
        try {
            const blob = naiNotionReferenceBase64Blob(record.base64, record.mime || 'image/png');
            const itemId = String(record.itemId);
            await naiNotionReferenceDbPutItem(itemId, {
                name: String(record.name || ''),
                originalName: String(record.originalName || ''),
                source: String(record.source || 'legacy'),
                blob,
                width: record.width,
                height: record.height,
                mime: record.mime || blob.type || 'image/png',
                cacheSecretKey: String(record.cacheSecretKey || '') || await naiNotionReferenceCacheSecretFromBlob(blob),
                savedAt: Number(record.savedAt || Date.now())
            });
            const clean = { ...record };
            delete clean.base64;
            delete clean.blob;
            const db = await naiNotionOpenPreciseReferenceDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(NAI_PRECISE_REFERENCE_STORE, 'readwrite');
                tx.objectStore(NAI_PRECISE_REFERENCE_STORE).put(clean);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error || new Error('Reference 활성 상태 마이그레이션에 실패했습니다.'));
            });
            return clean;
        } catch (_) {
            return record;
        }
    }

    async function naiNotionPrepareReferenceBlob(source) {
        if (!source || typeof source.arrayBuffer !== 'function') throw new Error('Reference 이미지 파일을 읽지 못했습니다.');
        let bitmap = null;
        try {
            bitmap = await createImageBitmap(source);
            const sourceRatio = bitmap.width / Math.max(1, bitmap.height);
            const targets = [
                { width: 1024, height: 1536 },
                { width: 1536, height: 1024 },
                { width: 1472, height: 1472 }
            ];
            const target = targets.reduce((best, candidate) => {
                const score = Math.abs(Math.log(sourceRatio / (candidate.width / candidate.height)));
                return !best || score < best.score ? { ...candidate, score } : best;
            }, null);

            const canvas = document.createElement('canvas');
            canvas.width = target.width;
            canvas.height = target.height;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) throw new Error('Reference 이미지 캔버스를 만들 수 없습니다.');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const scale = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const x = Math.floor((canvas.width - width) / 2);
            const y = Math.floor((canvas.height - height) / 2);
            ctx.drawImage(bitmap, x, y, width, height);
            const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!png) throw new Error('Reference PNG 변환에 실패했습니다.');
            return {
                blob: png,
                width: canvas.width,
                height: canvas.height,
                mime: 'image/png',
                cacheSecretKey: await naiNotionReferenceCacheSecretFromBlob(png)
            };
        } finally {
            try { bitmap?.close?.(); } catch (_) {}
        }
    }

    async function naiNotionPreparePreciseReference(item) {
        if (!item?._notionImageUrl) throw new Error('이 카드에는 Reference로 사용할 이미지가 없습니다. 왼쪽 이미지 버튼에서 로컬 이미지를 선택해주세요.');
        const source = await naiNotionFetchBlob(item._notionImageUrl);
        if (!source) throw new Error('Notion 원본 이미지를 불러오지 못했습니다. 동기화 후 다시 시도해주세요.');
        return await naiNotionPrepareReferenceBlob(source);
    }

    async function naiNotionResolveReferenceImage(item) {
        const id = naiNotionReferenceItemId(item);
        const local = await naiNotionReferenceDbGetItem(id);
        if (local?.blob && typeof local.blob.arrayBuffer === 'function') return local;
        if (item?._externalSourceId) {
            throw new Error('외부 라이브러리 레퍼런스 이미지를 먼저 선택해주세요.');
        }
        return await naiNotionPreparePreciseReference(item);
    }

    function naiNotionPickLocalReferenceFile() {
        return new Promise(resolve => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            let done = false;
            const finish = file => {
                if (done) return;
                done = true;
                input.remove();
                resolve(file || null);
            };
            input.addEventListener('change', () => finish(input.files?.[0] || null), { once: true });
            input.addEventListener('cancel', () => finish(null), { once: true });
            document.body.appendChild(input);
            input.click();
        });
    }

    async function naiNotionChooseLocalReferenceImage(item) {
        const id = naiNotionReferenceItemId(item);
        if (!id) throw new Error('Reference 카드 ID를 찾지 못했습니다.');
        const file = await naiNotionPickLocalReferenceFile();
        if (!file) return null;
        if (!String(file.type || '').startsWith('image/')) throw new Error('이미지 파일을 선택해주세요.');
        const prepared = await naiNotionPrepareReferenceBlob(file);
        await naiNotionReferenceDbPutItem(id, {
            name: String(item.name || ''),
            originalName: String(file.name || ''),
            source: 'local',
            blob: prepared.blob,
            width: prepared.width,
            height: prepared.height,
            mime: prepared.mime,
            cacheSecretKey: prepared.cacheSecretKey,
            savedAt: Date.now()
        });
        return prepared;
    }

    async function naiNotionHydrateReferencePreview(img, item) {
        if (!img) return;
        try {
            const local = await naiNotionReferenceDbGetItem(naiNotionReferenceItemId(item));
            if (local?.blob && typeof local.blob.arrayBuffer === 'function') {
                const objectUrl = URL.createObjectURL(local.blob);
                img.onload = () => URL.revokeObjectURL(objectUrl);
                img.onerror = () => URL.revokeObjectURL(objectUrl);
                img.src = objectUrl;
                img.dataset.referenceSource = 'local';
                return;
            }
        } catch (_) {}
        if (item?._externalSourceId) {
            const parent = img.parentElement;
            if (parent) parent.innerHTML = '<span class="nai-loader-muted">로컬 레퍼런스 이미지 없음</span>';
            return;
        }
        if (item?._notionImageUrl) naiNotionHydrateOriginal(img, item);
    }

    function naiNotionReferenceVisible(element) {
        if (!element || !(element instanceof Element)) return false;
        if (element.closest('.nai-loader-overlay, #nai-concept-loader-modal')) return false;
        const style = getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
    }

    function naiNotionReferenceText(element) {
        return String(element?.textContent || element?.getAttribute?.('aria-label') || element?.title || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    async function naiNotionWaitFor(predicate, timeout = 2600, step = 80) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            try {
                const result = predicate();
                if (result) return result;
            } catch (_) {}
            await new Promise(resolve => setTimeout(resolve, step));
        }
        return null;
    }

    function naiNotionSetNativeControlValue(control, value) {
        if (!control) return false;
        const stringValue = String(value);
        try {
            const proto = Object.getPrototypeOf(control);
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor?.set) descriptor.set.call(control, stringValue);
            else control.value = stringValue;
        } catch (_) {
            try { control.value = stringValue; } catch (_) { return false; }
        }
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }

    let naiNotionNativeReferenceSyncGuardUntil = 0;
    let naiNotionNativeReferenceTrackedPanel = null;
    let naiNotionNativeReferenceObserver = null;
    let naiNotionNativeReferenceCheckTimer = 0;

    function naiNotionGuardNativeReferenceSync(ms = 1400) {
        naiNotionNativeReferenceSyncGuardUntil = Math.max(
            naiNotionNativeReferenceSyncGuardUntil,
            Date.now() + Math.max(0, Number(ms) || 0)
        );
    }

    async function naiNotionClearArchiveReferenceState() {
        GM_deleteValue(NAI_NOTION.activeReferenceKey);
        await naiNotionReferenceDbClear();
        naiNotionNativeReferenceTrackedPanel = null;
        try { naiNotionController?.renderLibraryPanel?.(); } catch (_) {}
    }

    function naiNotionFindNativeReferencePanel() {
        const nodes = [...document.querySelectorAll('div,section,article,aside')]
            .filter(naiNotionReferenceVisible)
            .filter(node => {
                const text = naiNotionReferenceText(node).toLowerCase();
                return text.includes('strength') && text.includes('fidelity');
            })
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return (ar.width * ar.height) - (br.width * br.height);
            });
        return nodes[0] || null;
    }

    function naiNotionFindNativeReferenceRemoveButton(panel = null) {
        const referencePanel = panel || naiNotionFindNativeReferencePanel();
        if (!referencePanel) return null;

        const scopes = [referencePanel];
        let parent = referencePanel.parentElement;
        for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) scopes.push(parent);

        const candidates = [];
        const seen = new Set();
        for (const scope of scopes) {
            for (const button of scope.querySelectorAll('button,[role="button"]')) {
                if (seen.has(button) || !naiNotionReferenceVisible(button)) continue;
                seen.add(button);
                const text = naiNotionReferenceText(button).trim();
                const meta = [
                    text,
                    button.getAttribute?.('aria-label') || '',
                    button.getAttribute?.('title') || '',
                    button.getAttribute?.('data-tooltip') || '',
                    button.getAttribute?.('data-testid') || ''
                ].join(' ').trim();
                const insidePanel = referencePanel.contains(button);
                const rect = button.getBoundingClientRect();
                const panelRect = referencePanel.getBoundingClientRect();
                const topRight = rect.top <= panelRect.top + 100 && rect.right >= panelRect.right - 140;

                if (/remove|delete|clear|제거|삭제|지우|クリア|削除/i.test(meta)) {
                    candidates.push({ button, score: 120 + (insidePanel ? 20 : 0) + (topRight ? 10 : 0) });
                    continue;
                }
                if (/^(?:×|x|✕|✖|❌)$/i.test(text)) {
                    candidates.push({ button, score: 100 + (insidePanel ? 20 : 0) + (topRight ? 10 : 0) });
                    continue;
                }
                if (!text && button.querySelector('svg') && topRight) {
                    candidates.push({ button, score: 60 + (insidePanel ? 15 : 0) });
                }
            }
        }
        candidates.sort((a, b) => b.score - a.score);
        return candidates[0]?.button || null;
    }

    async function naiNotionRemoveNativeReferenceFromNovelAIUi() {
        if (!/novelai\.net$/i.test(location.hostname)) return true;
        const panel = naiNotionFindNativeReferencePanel();
        if (!panel) {
            naiNotionNativeReferenceTrackedPanel = null;
            return true;
        }

        const removeButton = naiNotionFindNativeReferenceRemoveButton(panel);
        if (!removeButton) return false;

        naiNotionGuardNativeReferenceSync(2400);
        removeButton.click();
        const removed = await naiNotionWaitFor(() => {
            if (!panel.isConnected) return true;
            const current = naiNotionFindNativeReferencePanel();
            return !current;
        }, 1800, 90);
        if (removed) naiNotionNativeReferenceTrackedPanel = null;
        return Boolean(removed);
    }

    function installNaiArchiveReferenceSync() {
        if (!/novelai\.net$/i.test(location.hostname)) return;
        const page = PAGE_WINDOW;
        if (page.__naiArchiveReferenceSyncInstalled) return;
        page.__naiArchiveReferenceSyncInstalled = true;

        const check = async () => {
            const active = naiNotionGetActiveReference();
            if (!active) {
                naiNotionNativeReferenceTrackedPanel = null;
                return;
            }

            if (naiNotionNativeReferenceTrackedPanel?.isConnected) return;

            const replacement = naiNotionFindNativeReferencePanel();
            if (replacement) {
                naiNotionNativeReferenceTrackedPanel = replacement;
                return;
            }

            // Only interpret disappearance as an explicit user OFF after a native
            // panel had actually been observed. This avoids clearing state merely
            // because NovelAI has not rendered the panel yet.
            if (!naiNotionNativeReferenceTrackedPanel) return;
            if (Date.now() < naiNotionNativeReferenceSyncGuardUntil) return;

            const disappearedPanel = naiNotionNativeReferenceTrackedPanel;
            await new Promise(resolve => setTimeout(resolve, 360));
            if (Date.now() < naiNotionNativeReferenceSyncGuardUntil) return;
            if (disappearedPanel.isConnected) return;

            const lateReplacement = naiNotionFindNativeReferencePanel();
            if (lateReplacement) {
                naiNotionNativeReferenceTrackedPanel = lateReplacement;
                return;
            }
            if (naiNotionGetActiveReference()) {
                await naiNotionClearArchiveReferenceState();
                naiNotionToast('NovelAI에서 레퍼런스를 제거해 Archive 레퍼런스도 OFF했습니다.');
            }
        };

        const scheduleCheck = () => {
            clearTimeout(naiNotionNativeReferenceCheckTimer);
            naiNotionNativeReferenceCheckTimer = setTimeout(() => check().catch(() => {}), 140);
        };

        const install = () => {
            if (naiNotionNativeReferenceObserver || !document.documentElement) return;
            naiNotionNativeReferenceObserver = new MutationObserver(scheduleCheck);
            naiNotionNativeReferenceObserver.observe(document.documentElement, { childList: true, subtree: true });
            document.addEventListener('click', scheduleCheck, true);

            // If an active Archive reference survived a reload, make it visible
            // again instead of leaving an invisible request-only reference active.
            setTimeout(() => {
                const active = naiNotionGetActiveReference();
                if (!active) return;
                const panel = naiNotionFindNativeReferencePanel();
                if (panel) {
                    naiNotionNativeReferenceTrackedPanel = panel;
                    return;
                }
                naiNotionScheduleNativeReferenceInsert();
            }, 700);
        };

        if (document.documentElement) install();
        else document.addEventListener('DOMContentLoaded', install, { once: true });
    }

    async function naiNotionSyncNativeReferenceControls(preset, preferredPanel = null) {
        const panel = preferredPanel || await naiNotionWaitFor(() => naiNotionFindNativeReferencePanel(), 3200, 100);
        if (!panel) return false;

        const desiredType = naiNotionNormalizeReferenceType(preset?.type);
        const typeLabels = {
            character: /^(character(?:\s+reference)?|캐릭터(?:\s*(?:레퍼런스|참조))?)$/i,
            style: /^(style(?:\s+reference)?|스타일(?:\s*(?:레퍼런스|참조))?)$/i,
            'character&style': /^(character\s*(?:&|\+|and)\s*style(?:\s+reference)?|캐릭터\s*(?:&|\+|그리고)\s*스타일(?:\s*(?:레퍼런스|참조))?)$/i
        };
        const typePattern = typeLabels[desiredType];
        const typeButton = [...panel.querySelectorAll('button,[role="button"]')]
            .filter(naiNotionReferenceVisible)
            .find(button => typePattern.test(naiNotionReferenceText(button)));
        if (typeButton) typeButton.click();
        else {
            const select = [...panel.querySelectorAll('select')].find(naiNotionReferenceVisible);
            if (select) {
                const option = [...select.options].find(row => typePattern.test(String(row.textContent || '').trim()));
                if (option) naiNotionSetNativeControlValue(select, option.value);
            }
        }

        const setLabeled = (labelText, otherLabelText, value) => {
            const labels = [...panel.querySelectorAll('label,span,div')]
                .filter(naiNotionReferenceVisible)
                .filter(node => new RegExp(`^${labelText}$`, 'i').test(naiNotionReferenceText(node)));

            for (const label of labels) {
                let scope = label.parentElement;
                for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
                    const inputs = [...scope.querySelectorAll('input[type="range"], input[type="number"]')]
                        .filter(naiNotionReferenceVisible);
                    if (!inputs.length) continue;

                    const hasOtherLabel = [...scope.querySelectorAll('label,span,div')]
                        .filter(naiNotionReferenceVisible)
                        .some(node => new RegExp(`^${otherLabelText}$`, 'i').test(naiNotionReferenceText(node)));

                    if (hasOtherLabel) continue;

                    inputs.forEach(input => naiNotionSetNativeControlValue(input, value));
                    return true;
                }
            }
            return false;
        };
        setLabeled('Strength', 'Fidelity', naiNotionReferenceSnap(preset?.strength, 1));
        setLabeled('Fidelity', 'Strength', naiNotionReferenceSnap(preset?.fidelity, 1));
        return true;
    }

    async function naiNotionInsertActiveReferenceIntoNovelAIUi() {
        if (!/novelai\.net$/i.test(location.hostname)) return false;
        const active = naiNotionGetActiveReference();
        if (!active) return false;

        // If NovelAI already has a Precise Reference panel, only update its
        // type/strength/fidelity. Re-pasting here used to create a duplicate
        // Character & Style reference every time the settings were changed.
        const existingPanel = naiNotionFindNativeReferencePanel();
        if (existingPanel) {
            naiNotionNativeReferenceTrackedPanel = existingPanel;
            return await naiNotionSyncNativeReferenceControls(active, existingPanel);
        }

        const image = await naiNotionReferenceDbGetItem(active.itemId);
        if (!image?.blob || typeof image.blob.arrayBuffer !== 'function') return false;

        const blob = new (PAGE_WINDOW.Blob || Blob)([image.blob], { type: image.mime || image.blob.type || 'image/png' });
        const FileCtor = PAGE_WINDOW.File || File;
        const file = new FileCtor([blob], 'nai-archive-reference.png', { type: 'image/png' });
        const DataTransferCtor = PAGE_WINDOW.DataTransfer || DataTransfer;
        let transfer;
        try {
            transfer = new DataTransferCtor();
            transfer.items.add(file);
        } catch (_) {
            return false;
        }

        const dispatchPaste = target => {
            try {
                let event;
                const ClipboardEventCtor = PAGE_WINDOW.ClipboardEvent || ClipboardEvent;
                try {
                    event = new ClipboardEventCtor('paste', { bubbles: true, cancelable: true, clipboardData: transfer });
                } catch (_) {
                    event = new Event('paste', { bubbles: true, cancelable: true });
                }
                if (!event.clipboardData) {
                    try { Object.defineProperty(event, 'clipboardData', { configurable: true, value: transfer }); } catch (_) {}
                }
                return target.dispatchEvent(event);
            } catch (_) {
                return false;
            }
        };

        dispatchPaste(document.activeElement instanceof Element ? document.activeElement : document.body);

        const preciseButton = await naiNotionWaitFor(() => {
            const candidates = [...document.querySelectorAll('button,[role="button"]')]
                .filter(naiNotionReferenceVisible)
                .filter(button => !button.closest('.nai-loader-overlay, #nai-concept-loader-modal'));
            return candidates.find(button => {
                const text = naiNotionReferenceText(button).toLowerCase();
                return text.includes('precise reference') || text.includes('정밀 참조') || text.includes('精密参照');
            }) || null;
        }, 1800, 75);

        if (!preciseButton) {
            // Some builds listen for drag/drop instead of paste. Try one drop as fallback.
            try {
                const dropTarget = document.querySelector('main') || document.body;
                const DragEventCtor = PAGE_WINDOW.DragEvent || DragEvent;
                let dropEvent;
                try {
                    dropEvent = new DragEventCtor('drop', { bubbles: true, cancelable: true, dataTransfer: transfer });
                } catch (_) {
                    dropEvent = new Event('drop', { bubbles: true, cancelable: true });
                    try { Object.defineProperty(dropEvent, 'dataTransfer', { configurable: true, value: transfer }); } catch (_) {}
                }
                dropTarget.dispatchEvent(dropEvent);
            } catch (_) {}
        } else {
            preciseButton.click();
        }

        const secondPreciseButton = preciseButton ? null : await naiNotionWaitFor(() => {
            const candidates = [...document.querySelectorAll('button,[role="button"]')]
                .filter(naiNotionReferenceVisible)
                .filter(button => !button.closest('.nai-loader-overlay, #nai-concept-loader-modal'));
            return candidates.find(button => {
                const text = naiNotionReferenceText(button).toLowerCase();
                return text.includes('precise reference') || text.includes('정밀 참조') || text.includes('精密参照');
            }) || null;
        }, 1800, 75);
        if (secondPreciseButton) secondPreciseButton.click();

        const controlsSynced = await naiNotionSyncNativeReferenceControls(active);
        const nativePanel = naiNotionFindNativeReferencePanel();
        if (nativePanel) naiNotionNativeReferenceTrackedPanel = nativePanel;
        return Boolean(preciseButton || secondPreciseButton || controlsSynced || nativePanel);
    }

    function naiNotionScheduleNativeReferenceInsert() {
        naiNotionGuardNativeReferenceSync(3200);
        setTimeout(() => {
            naiNotionInsertActiveReferenceIntoNovelAIUi().then(ok => {
                if (!ok) {
                    naiNotionToast('레퍼런스는 생성 요청에 적용됩니다. NovelAI 화면 삽입은 감지하지 못했습니다.', true);
                }
            }).catch(error => {
                console.warn(`[${APP_NAME}] Native Precise Reference UI bridge failed`, error);
            });
        }, 180);
    }

    async function naiNotionApplyPreciseReference(item, preset = null) {
        const id = naiNotionReferenceItemId(item);
        if (!id) throw new Error('Reference 카드 ID를 찾지 못했습니다.');
        const next = preset || naiNotionGetReferencePreset(item);
        const normalized = {
            type: 'character&style',
            strength: naiNotionReferenceSnap(next?.strength, 1),
            fidelity: naiNotionReferenceSnap(next?.fidelity, 1)
        };
        naiNotionSaveReferencePreset(item, normalized);
        const prepared = await naiNotionResolveReferenceImage(item);
        const cacheSecretKey = prepared.cacheSecretKey || await naiNotionReferenceCacheSecretFromBlob(prepared.blob);
        await naiNotionReferenceDbPutItem(id, {
            name: String(item.name || ''),
            originalName: String(prepared.originalName || ''),
            source: String(prepared.source || (item?._externalSourceId ? 'external-local' : 'personal')),
            blob: prepared.blob,
            width: prepared.width,
            height: prepared.height,
            mime: prepared.mime || prepared.blob?.type || 'image/png',
            cacheSecretKey,
            savedAt: Date.now()
        });
        await naiNotionReferenceDbPut({
            itemId: id,
            name: String(item.name || ''),
            cacheSecretKey,
            savedAt: Date.now()
        });
        GM_setValue(NAI_NOTION.activeReferenceKey, {
            enabled: true,
            itemId: id,
            name: String(item.name || ''),
            type: normalized.type,
            strength: normalized.strength,
            fidelity: normalized.fidelity,
            cacheSecretKey,
            updatedAt: Date.now()
        });
        return normalized;
    }

    function naiNotionSaveReferenceSettingsOnly(item, preset) {
        const id = naiNotionReferenceItemId(item);
        const normalized = {
            type: 'character&style',
            strength: naiNotionReferenceSnap(preset?.strength, 1),
            fidelity: naiNotionReferenceSnap(preset?.fidelity, 1)
        };
        naiNotionSaveReferencePreset(item, normalized);
        const active = naiNotionGetActiveReference();
        if (active && active.itemId === id) {
            GM_setValue(NAI_NOTION.activeReferenceKey, {
                ...active,
                type: normalized.type,
                strength: normalized.strength,
                fidelity: normalized.fidelity,
                updatedAt: Date.now()
            });
            // Update the existing native panel only; do not import the image again.
            setTimeout(() => {
                const panel = naiNotionFindNativeReferencePanel();
                if (panel) naiNotionSyncNativeReferenceControls(normalized, panel).catch(() => {});
            }, 0);
        }
        return normalized;
    }

    async function naiNotionDisablePreciseReference(item = null) {
        const active = naiNotionGetActiveReference();
        if (item && active && active.itemId !== naiNotionReferenceItemId(item)) return false;

        const nativeRemoved = await naiNotionRemoveNativeReferenceFromNovelAIUi();
        if (!nativeRemoved) {
            naiNotionToast('NovelAI 레퍼런스 제거 버튼을 찾지 못해 OFF하지 않았습니다.', true);
            return false;
        }

        await naiNotionClearArchiveReferenceState();
        return true;
    }

    function naiNotionReferenceModal(item) {
        return new Promise(resolve => {
            const id = naiNotionReferenceItemId(item);
            const preset = naiNotionGetReferencePreset(item);
            const active = naiNotionGetActiveReference();
            const isActive = Boolean(active && active.itemId === id);
            const current = isActive ? {
                type: active.type,
                strength: active.strength,
                fidelity: active.fidelity
            } : preset;

            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-reference-modal';
            overlay.innerHTML = `<div class="nai-loader-modal nai-notion-reference-modal">
                <div class="nai-loader-header">
                    <div class="nai-loader-title"><span>레퍼런스</span></div>
                    <button type="button" class="nai-loader-close" data-close>×</button>
                </div>
                <div class="nai-loader-content"><div class="nai-loader-panel active">
                    <div class="nai-notion-reference-preview"><img data-ref-preview alt="Reference preview"></div>
                    <div class="nai-notion-reference-control">
                        <div class="nai-notion-reference-control-head"><span>Strength</span><input type="number" min="0" max="1" step="0.05" data-ref-strength-number value="${escapeHtml(String(current.strength))}"></div>
                        <input type="range" min="0" max="1" step="0.05" data-ref-strength value="${escapeHtml(String(current.strength))}">
                    </div>
                    <div class="nai-notion-reference-control">
                        <div class="nai-notion-reference-control-head"><span>Fidelity</span><input type="number" min="0" max="1" step="0.05" data-ref-fidelity-number value="${escapeHtml(String(current.fidelity))}"></div>
                        <input type="range" min="0" max="1" step="0.05" data-ref-fidelity value="${escapeHtml(String(current.fidelity))}">
                    </div>
                    <div class="nai-edit-footer-actions nai-notion-reference-actions">
                        <span class="nai-notion-inline-status" data-ref-status>${isActive ? '현재 이 카드가 ON' : ''}</span>
                        <button type="button" class="nai-loader-action" data-ref-off ${isActive ? '' : 'disabled'}>레퍼런스 OFF</button>
                        <button type="button" class="nai-loader-action" data-ref-save>설정 저장</button>
                        <button type="button" class="nai-loader-action primary" data-ref-apply>레퍼런스 적용</button>
                    </div>
                </div></div>
            </div>`;

            const status = overlay.querySelector('[data-ref-status]');
            const strengthRange = overlay.querySelector('[data-ref-strength]');
            const strengthNumber = overlay.querySelector('[data-ref-strength-number]');
            const fidelityRange = overlay.querySelector('[data-ref-fidelity]');
            const fidelityNumber = overlay.querySelector('[data-ref-fidelity-number]');
            const selectedType = "character&style";

            const syncPair = (range, number) => {
                const applyValue = value => {
                    const snapped = naiNotionReferenceSnap(value, 1);
                    range.value = snapped.toFixed(2);
                    number.value = snapped.toFixed(2);
                };
                range.addEventListener('input', () => applyValue(range.value));
                range.addEventListener('change', () => applyValue(range.value));
                number.addEventListener('input', () => applyValue(number.value));
                number.addEventListener('change', () => applyValue(number.value));
                applyValue(range.value || number.value || 1);
            };
            syncPair(strengthRange, strengthNumber);
            syncPair(fidelityRange, fidelityNumber);

            const preview = overlay.querySelector('[data-ref-preview]');
            if (preview) naiNotionHydrateReferencePreview(preview, item);

            const finish = value => { overlay.remove(); resolve(value); };
            overlay.querySelector('[data-close]').onclick = () => finish(null);
            overlay.addEventListener('mousedown', event => { if (event.target === overlay) finish(null); });

            overlay.querySelector('[data-ref-off]').onclick = async () => {
                status.textContent = 'Reference 끄는 중…';
                const disabled = await naiNotionDisablePreciseReference(item);
                if (!disabled) {
                    status.textContent = 'NovelAI 레퍼런스 제거를 확인하지 못했습니다.';
                    return;
                }
                naiNotionToast('레퍼런스 OFF');
                finish({ enabled: false });
            };

            overlay.querySelector('[data-ref-save]').onclick = () => {
                const next = {
                    type: selectedType,
                    strength: naiNotionReferenceSnap(strengthNumber.value, 1),
                    fidelity: naiNotionReferenceSnap(fidelityNumber.value, 1)
                };
                const saved = naiNotionSaveReferenceSettingsOnly(item, next);
                status.textContent = `설정 저장 완료 · S ${saved.strength.toFixed(2)} · F ${saved.fidelity.toFixed(2)}`;
                naiNotionToast('레퍼런스 설정 저장 완료');
            };

            overlay.querySelector('[data-ref-apply]').onclick = async event => {
                const button = event.currentTarget;
                const next = {
                    type: selectedType,
                    strength: naiNotionReferenceSnap(strengthNumber.value, 1),
                    fidelity: naiNotionReferenceSnap(fidelityNumber.value, 1)
                };
                button.disabled = true;
                status.textContent = 'Reference 이미지 준비 중…';
                try {
                    const applied = await naiNotionApplyPreciseReference(item, next);
                    naiNotionToast(`레퍼런스 ON · ${item.name || '카드'}`);
                    finish({ enabled: true, preset: applied });
                    naiNotionScheduleNativeReferenceInsert();
                } catch (error) {
                    status.textContent = naiNotionHumanizeError(error);
                    button.disabled = false;
                }
            };

            document.body.appendChild(overlay);
        });
    }

    async function naiNotionInjectActiveReferenceIntoFormData(formData) {
        const active = naiNotionGetActiveReference();
        if (!active || !formData || typeof formData.get !== 'function') return false;

        const requestPart = formData.get('request');
        if (!requestPart) return false;
        let requestText = '';
        if (typeof requestPart === 'string') requestText = requestPart;
        else if (typeof requestPart.text === 'function') requestText = await requestPart.text();
        else return false;

        const payload = JSON.parse(requestText);
        const model = String(payload?.model || '');
        if (!/nai-diffusion-4-5/i.test(model)) return false;
        if (!payload.parameters || typeof payload.parameters !== 'object') payload.parameters = {};

        // If NovelAI is visibly holding this Precise Reference but its own
        // outgoing request has the reference disabled, respect that state.
        // Keep Archive's saved active reference intact so re-enabling it still works.
        const nativePanel = naiNotionFindNativeReferencePanel();
        if (nativePanel) {
            const p = payload.parameters;
            const nativeRequestHasReference =
                (Array.isArray(p.director_reference_descriptions) && p.director_reference_descriptions.length > 0) ||
                (Array.isArray(p.director_reference_information_extracted) && p.director_reference_information_extracted.some(value => Number(value) > 0)) ||
                (Array.isArray(p.director_reference_images_cached) && p.director_reference_images_cached.length > 0) ||
                (typeof formData.keys === 'function' && [...formData.keys()].some(key => /^director_ref_\d+$/i.test(String(key))));
            if (!nativeRequestHasReference) return false;
        }

        const image = await naiNotionReferenceDbGetItem(active.itemId);
        if (!image?.blob || typeof image.blob.arrayBuffer !== 'function') {
            throw new Error('저장된 레퍼런스 이미지가 없습니다. 라이브러리에서 레퍼런스를 다시 적용해주세요.');
        }

        let cacheSecretKey = active.cacheSecretKey;
        if (!/^[0-9a-f]{64}$/i.test(cacheSecretKey)) {
            cacheSecretKey = naiNotionReferenceCacheSecret();
            GM_setValue(NAI_NOTION.activeReferenceKey, { ...active, cacheSecretKey, updatedAt: Date.now() });
        }

        const parameters = payload.parameters;
        delete parameters.director_reference_images;
        parameters.director_reference_descriptions = [{
            caption: { base_caption: active.type, char_captions: [] },
            legacy_uc: false
        }];
        parameters.director_reference_information_extracted = [1];
        parameters.director_reference_strength_values = [naiNotionReferenceSnap(active.strength, 1)];
        parameters.director_reference_secondary_strength_values = [Number((1 - naiNotionReferenceSnap(active.fidelity, 1)).toFixed(2))];
        parameters.director_reference_images_cached = [{
            cache_secret_key: cacheSecretKey,
            data: 'director_ref_0'
        }];

        // Precise Reference and Vibe Transfer are mutually exclusive in NovelAI's UI.
        delete parameters.reference_image_multiple;
        delete parameters.reference_strength_multiple;
        delete parameters.reference_information_extracted_multiple;
        delete parameters.reference_image_multiple_cached;

        if (typeof formData.keys === 'function' && typeof formData.delete === 'function') {
            for (const key of [...formData.keys()]) {
                if (/^director_ref_\d+$/i.test(String(key))) formData.delete(key);
            }
        }

        const referenceBlob = new (PAGE_WINDOW.Blob || Blob)([image.blob], { type: image.mime || image.blob.type || 'image/png' });
        const requestBlob = new (PAGE_WINDOW.Blob || Blob)([JSON.stringify(payload)], { type: 'application/json' });

        // Match NovelAI's multipart shape: director_ref_0 PNG + request JSON blob.
        formData.delete?.('request');
        formData.append?.('director_ref_0', referenceBlob, 'blob');
        formData.append?.('request', requestBlob, 'blob');
        return true;
    }

    function installNaiArchiveReferenceInterceptor() {
        const page = PAGE_WINDOW;
        if (page.__naiArchiveReferenceInterceptorInstalled) return;
        page.__naiArchiveReferenceInterceptorInstalled = true;
        try {
            const originalFetch = page.fetch;
            if (typeof originalFetch !== 'function') return;
            page.fetch = async function(input, init) {
                let nextInput = input;
                let nextInit = init;
                const url = String(typeof input === 'string' ? input : (input?.url || ''));
                const method = String(init?.method || input?.method || 'GET').toUpperCase();

                if (method === 'POST' && /generate-image/i.test(url)) {
                    try {
                        // Common browser path: fetch(url, { body: FormData }).
                        if (init?.body && typeof init.body.get === 'function') {
                            await naiNotionInjectActiveReferenceIntoFormData(init.body);
                        } else {
                            // Some NovelAI builds wrap the multipart body in a Request first.
                            const RequestCtor = page.Request || Request;
                            if (input instanceof RequestCtor && typeof input.clone === 'function') {
                                const contentType = String(input.headers?.get?.('content-type') || '');
                                if (/multipart\/form-data/i.test(contentType) && typeof input.clone().formData === 'function') {
                                    const formData = await input.clone().formData();
                                    const changed = await naiNotionInjectActiveReferenceIntoFormData(formData);
                                    if (changed) {
                                        const HeadersCtor = page.Headers || Headers;
                                        const headers = new HeadersCtor(input.headers);
                                        // The browser must generate a new multipart boundary for the rebuilt body.
                                        headers.delete('content-type');
                                        headers.delete('content-length');
                                        nextInput = new RequestCtor(input, { body: formData, headers });
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.error(`[${APP_NAME}] Precise Reference injection failed`, error);
                        setTimeout(() => naiNotionToast(`Reference 적용 실패 · ${naiNotionHumanizeError(error)}`, true), 0);
                    }
                }
                return originalFetch.call(this, nextInput, nextInit);
            };
        } catch (error) {
            console.error(`[${APP_NAME}] Precise Reference interceptor install failed`, error);
        }
    }

    function naiNotionDetailModal(item) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-detail-modal';
            const characters = normalizeCharacterRows(item.characters);
            const characterPromptText = naiNotionFormatCharacters(characters, 'prompt');
            const characterNegativeText = naiNotionFormatCharacters(characters, 'negative');
            const referenceActive = naiNotionReferenceIsItemActive(item);
            overlay.innerHTML = `<div class="nai-loader-modal nai-notion-detail-modal"><div class="nai-loader-header"><div class="nai-loader-title"><span>${escapeHtml(item.name)}</span></div><button type="button" class="nai-loader-close" data-close>×</button></div><div class="nai-loader-content"><div class="nai-loader-panel active"><div class="nai-notion-detail-image">${item._notionImageUrl ? `<img data-detail-img alt="">` : ''}</div><div class="nai-edit-footer-actions nai-notion-detail-actions"><button type="button" class="nai-loader-action danger" data-action="delete">삭제</button><button type="button" class="nai-loader-action nai-notion-reference-text ${referenceActive ? 'active' : ''}" data-action="reference" title="레퍼런스 설정${referenceActive ? ' · ON' : ''}">레퍼런스</button><button type="button" class="nai-loader-action" data-action="notion">Notion에서 열기</button><button type="button" class="nai-loader-action" data-action="copy">복사</button><button type="button" class="nai-loader-action" data-action="save">수정 저장</button><span class="nai-notion-inline-status" data-status></span><button type="button" class="nai-loader-action primary" data-action="use">사용</button></div><div class="nai-loader-field"><label class="nai-loader-label">Name</label><input class="nai-loader-input" data-field="name" value="${escapeHtml(item.name)}"></div><div class="nai-loader-field"><label class="nai-loader-label">Categories</label><input class="nai-loader-input" data-field="categories" value="${escapeHtml((item.categories||[]).join(', '))}"></div><div class="nai-loader-field"><label class="nai-loader-label">Base Prompt</label><textarea class="nai-loader-textarea" data-field="tags">${escapeHtml(item.tags||'')}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Undesired Content</label><textarea class="nai-loader-textarea" data-field="negativeTags">${escapeHtml(item.negativeTags||'')}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Character Prompt</label><textarea class="nai-loader-textarea" data-field="characterPrompt" placeholder="[Character 1] prompt">${escapeHtml(characterPromptText)}</textarea></div><div class="nai-loader-field"><label class="nai-loader-label">Character Negative / UC</label><textarea class="nai-loader-textarea" data-field="characterNegative" placeholder="[Character 1] undesired content">${escapeHtml(characterNegativeText)}</textarea></div><div class="nai-loader-row nai-notion-meta-row"><span>Seed ${escapeHtml(item._notionSeed||'-')}</span><span>Steps ${escapeHtml(item._notionSteps??'-')}</span><span>Guidance ${escapeHtml(item._notionGuidance??'-')}</span><span>Rescale ${escapeHtml(item._notionGuidanceRescale??'-')}</span></div><div class="nai-loader-field"><label class="nai-loader-label">Memo</label><textarea class="nai-loader-textarea" data-field="note">${escapeHtml(item.note||'')}</textarea></div></div></div></div>`;
            const status = overlay.querySelector('[data-status]');
            const close = () => { overlay.remove(); resolve(); };
            overlay.querySelector('[data-close]').onclick = close;
            overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
            const img = overlay.querySelector('[data-detail-img]');
            if (img) naiNotionHydrateOriginal(img, item);
            overlay.addEventListener('click', async event => {
                const button = event.target.closest('[data-action]');
                if (!button) return;
                const action = button.dataset.action;
                try {
                    if (action === 'use') {
                        status.textContent = 'NovelAI에 적용하는 중…';
                        const result = await naiNotionReplaceConceptInNovelAI(item);
                        status.textContent = result.ok ? '적용 완료.' : result.error;
                    } else if (action === 'reference') {
                        const result = await naiNotionReferenceModal(item);
                        if (result) {
                            button.classList.toggle('active', Boolean(result.enabled));
                            button.title = `레퍼런스 설정${result.enabled ? ' · ON' : ''}`;
                            status.textContent = result.enabled ? '레퍼런스 ON.' : '레퍼런스 OFF.';
                        }
                    } else if (action === 'copy') {
                        const ok = await copyText(item.tags || '');
                        status.textContent = ok ? 'Base Prompt를 복사했습니다.' : '복사에 실패했습니다.';
                    } else if (action === 'notion') {
                        const url = item._notionPageUrl || item.source?.url;
                        if (url) window.open(url, '_blank', 'noopener,noreferrer');
                    } else if (action === 'save') {
                        const characters = naiNotionParseEditableCharacterText(
                            overlay.querySelector('[data-field="characterPrompt"]').value,
                            overlay.querySelector('[data-field="characterNegative"]').value
                        );
                        const next = normalizeConceptRecord({
                            ...item,
                            name: overlay.querySelector('[data-field="name"]').value.trim(),
                            tags: overlay.querySelector('[data-field="tags"]').value.trim(),
                            negativeTags: overlay.querySelector('[data-field="negativeTags"]').value.trim(),
                            characters,
                            note: overlay.querySelector('[data-field="note"]').value.trim(),
                            categories: overlay.querySelector('[data-field="categories"]').value.split(',').map(x=>x.trim())
                        });
                        if (!next.name) { status.textContent = 'Name을 입력해주세요.'; return; }
                        if (!next.tags && !next.negativeTags && !next.characters.length) {
                            status.textContent = 'Base / UC / Character Prompt 중 하나는 있어야 합니다.';
                            return;
                        }
                        status.textContent = 'Notion에 수정 내용을 저장하는 중…';
                        await naiNotionUpdatePage(item, next);
                        status.textContent = '수정 완료.';
                        Object.assign(item, next);
                        naiNotionController?.renderLibraryPanel?.();
                    } else if (action === 'delete') {
                        const confirmed = await naiNotionConfirmModal({
                            title: 'Notion 항목 삭제',
                            message: `“${item.name}” 항목을 Notion에서 삭제할까요?`,
                            confirmText: '삭제',
                            cancelText: '취소',
                            danger: true
                        });
                        if (!confirmed) return;
                        status.textContent = '삭제 중…';
                        await naiNotionDeletePage(item);
                        if (naiNotionReferenceIsItemActive(item)) await naiNotionDisablePreciseReference(item);
                        naiNotionController?.renderLibraryPanel?.();
                        close();
                    }
                } catch (error) { status.textContent = naiNotionHumanizeError(error); }
            });
            document.body.appendChild(overlay);
        });
    }

    function naiNotionSaveModal(initialDraft, previewInfo, preparePromise) {
        return new Promise(resolve => {
            const prefs = naiNotionGetPrefs();
            let liveDraft = { ...initialDraft };
            let liveImageInfo = null;
            let ready = !preparePromise;

            const overlay = document.createElement('div');
            overlay.className = 'nai-loader-overlay';
            overlay.id = 'nai-notion-save-modal';
            overlay.innerHTML = `<div class="nai-loader-modal nai-notion-save-modal">
                <div class="nai-loader-header">
                    <div class="nai-loader-title"><span>Notion에 저장</span></div>
                    <button type="button" class="nai-loader-close" data-close>×</button>
                </div>
                <div class="nai-loader-content"><div class="nai-loader-panel active">
                    <div class="nai-notion-save-preview">
                        ${previewInfo?.src ? `<img src="${escapeHtml(previewInfo.src)}" alt="현재 이미지">` : ''}
                    </div>
                    <div class="nai-loader-field">
                        <label class="nai-loader-label">이름</label>
                        <input class="nai-loader-input" data-name value="${escapeHtml(initialDraft.name || '')}">
                    </div>
                    <div class="nai-loader-field">
                        <label class="nai-loader-label">저장할 항목</label>
                        <div class="nai-notion-check-grid">
                            ${[['image','이미지'],['basePrompt','Base Prompt'],['negativePrompt','Undesired Content'],['characterPrompt','Character Prompt'],['seed','Seed'],['steps','Steps'],['guidance','Guidance'],['guidanceRescale','Guidance Rescale']]
                                .map(([key,label])=>`<label class="nai-notion-check-item"><input type="checkbox" data-pref="${key}" ${prefs[key]?'checked':''}><span>${label}</span></label>`)
                                .join('')}
                        </div>
                    </div>
                    <div class="nai-loader-field">
                        <label class="nai-loader-label">분류</label>
                        <input class="nai-loader-input" data-categories placeholder="구도, 화풍, 포즈">
                    </div>
                    <div class="nai-loader-field">
                        <label class="nai-loader-label">메모</label>
                        <textarea class="nai-loader-textarea" data-memo></textarea>
                    </div>
                    <div class="nai-edit-footer-actions nai-notion-save-actions">
                        <button type="button" class="nai-loader-action" data-cancel>취소</button>
                        <span class="nai-notion-inline-status" data-status>${ready ? '' : '현재 이미지와 Prompt 정보를 읽는 중…'}</span>
                        <button type="button" class="nai-loader-action primary" data-save ${ready ? '' : 'disabled'}>${ready ? '저장' : '정보 불러오는 중…'}</button>
                    </div>
                </div></div>
            </div>`;

            const catsInput = overlay.querySelector('[data-categories]');
            const status = overlay.querySelector('[data-status]');
            const saveButton = overlay.querySelector('[data-save]');

            const finish = value => {
                overlay.remove();
                resolve(value);
            };

            overlay.querySelector('[data-close]').onclick = () => finish(null);
            overlay.querySelector('[data-cancel]').onclick = () => finish(null);

            saveButton.onclick = () => {
                if (!ready) return;
                const name = overlay.querySelector('[data-name]').value.trim();
                if (!name) {
                    status.textContent = '이름을 입력해주세요.';
                    return;
                }
                const nextPrefs = {};
                overlay.querySelectorAll('[data-pref]').forEach(input => {
                    nextPrefs[input.dataset.pref] = input.checked;
                });
                if (!Object.values(nextPrefs).some(Boolean)) {
                    status.textContent = '저장할 항목을 하나 이상 선택해주세요.';
                    return;
                }
                naiNotionSetPrefs(nextPrefs);
                finish({
                    draft: {
                        ...liveDraft,
                        name,
                        categories: normalizeLibraryCategoryList(
                            catsInput.value.split(',').map(x => x.trim())
                        ),
                        memo: overlay.querySelector('[data-memo]').value.trim(),
                        prefs: nextPrefs
                    },
                    imageInfo: liveImageInfo
                });
            };

            document.body.appendChild(overlay);
            requestAnimationFrame(() => overlay.querySelector('[data-name]')?.focus());

            if (preparePromise) {
                Promise.resolve(preparePromise)
                    .then(prepared => {
                        if (!overlay.isConnected) return;
                        liveDraft = {
                            ...liveDraft,
                            ...(prepared?.draft || {})
                        };
                        liveImageInfo = prepared?.imageInfo || null;
                        ready = true;
                        saveButton.disabled = false;
                        saveButton.textContent = '저장';
                        status.textContent = '저장할 항목을 선택해주세요.';
                    })
                    .catch(error => {
                        if (!overlay.isConnected) return;
                        ready = false;
                        saveButton.disabled = true;
                        saveButton.textContent = '불러오기 실패';
                        status.textContent = naiNotionHumanizeError(error);
                    });
            }
        });
    }

    async function naiNotionOpenSaveFlow(button) {
        if (button?.dataset.busy === '1') return;
        if (button) {
            button.dataset.busy = '1';
            button.style.opacity = '0.55';
        }

        try {
            const token = await naiNotionGetTokenInteractive();
            if (!token) return;

            // Show the options UI before any Notion network call or PNG metadata
            // parsing.  This makes the icon feel immediate.
            const visibleImage = naiNotionFindCurrentImageElement();
            if (!visibleImage) {
                throw new Error('현재 화면에서 NAI 이미지를 찾지 못했습니다.');
            }

            const initialDraft = {
                name: `NAI · ${new Date().toLocaleString('ko-KR', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit'
                })}`,
                basePrompt: '',
                negativePrompt: '',
                characters: [],
                categories: [],
                memo: '',
                sourceUrl: location.href
            };

            const preparePromise = (async () => {
                const [imageInfo, promptState] = await Promise.all([
                    naiNotionGetCurrentImage(),
                    naiNotionReadCurrentPromptState()
                ]);
                const meta = naiNotionMetadataFields(imageInfo.metadata);
                return {
                    imageInfo,
                    draft: {
                        ...initialDraft,
                        ...meta,
                        ...promptState
                    }
                };
            })();

            const modalResult = await naiNotionSaveModal(
                initialDraft,
                { src: visibleImage.currentSrc || visibleImage.src },
                preparePromise
            );
            if (!modalResult) return;

            const confirmed = modalResult.draft;
            const imageInfo = modalResult.imageInfo;
            const prefs = confirmed.prefs;

            // Only now touch the Notion API. The options window has already
            // appeared and the user has confirmed the save.
            naiNotionController?.toast?.('Notion 저장소를 확인하는 중…');
            const archive = await naiNotionEnsureArchive(token, true);

            let upload = null;
            naiNotionController?.toast?.('Notion에 저장하는 중…');
            if (prefs.image) {
                if (!imageInfo?.blob) {
                    throw new Error('저장할 이미지 데이터를 준비하지 못했습니다.');
                }
                upload = await naiNotionUploadImage(
                    token,
                    imageInfo.blob,
                    confirmed
                );
            }

            const page = await naiNotionCreatePage(
                token,
                archive,
                confirmed,
                prefs,
                upload
            );
            if (!page?.id) {
                throw new Error('Notion 페이지 생성 결과를 확인하지 못했습니다.');
            }

            const mapped = naiNotionMapPage(page);
            const cache = naiNotionCurrentCache();
            naiNotionSaveCache({
                dataSourceId: archive.dataSourceId,
                lastSync: Date.now(),
                items: [
                    mapped,
                    ...cache.items.filter(
                        x => (x._notionPageId || x.id) !== mapped.id
                    )
                ]
            });

            naiNotionController?.toast?.('Notion 저장이 완료되었습니다 ✓');
            naiNotionSyncPersonal({ quiet: true }).catch(() => {});
        } catch (error) {
            console.error(`[${APP_NAME}] Notion save failed`, error);
            naiNotionController?.toast?.(
                naiNotionHumanizeError(error),
                true
            );
        } finally {
            if (button) {
                button.dataset.busy = '0';
                button.style.opacity = '';
            }
        }
    }

    async function naiNotionMigrateLegacyLibrary({ offerDelete = true } = {}) {
        const local = getLibrary().map(normalizeConceptRecord);
        if (!local.length) {
            return {
                total: 0,
                migrated: 0,
                existing: 0,
                failed: 0,
                deleted: false
            };
        }

        const token = await naiNotionGetTokenInteractive();
        if (!token) {
            return {
                total: local.length,
                migrated: 0,
                existing: 0,
                failed: local.length,
                deleted: false
            };
        }

        const archive = await naiNotionEnsureArchive(token, true);

        // Refresh once before migration so retrying a partial migration doesn't
        // create duplicate Notion rows.
        try {
            await naiNotionSyncPersonal({ force: true, quiet: true });
        } catch (_) {}

        const existingKeys = new Set(
            (naiNotionCurrentCache().items || []).map(conceptExactContentKey)
        );

        let migrated = 0;
        let existing = 0;
        let failed = 0;

        for (let index = 0; index < local.length; index++) {
            const normalized = local[index];
            const key = conceptExactContentKey(normalized);

            if (existingKeys.has(key)) {
                existing++;
                naiNotionSetLibraryStatus(
                    `기존 라이브러리 백업 중… ${index + 1}/${local.length} · 이미 백업됨 ${existing}`
                );
                continue;
            }

            naiNotionSetLibraryStatus(
                `기존 라이브러리 백업 중… ${index + 1}/${local.length} · 성공 ${migrated}`
            );

            try {
                const draft = {
                    name: normalized.name || 'Untitled',
                    basePrompt: normalized.tags,
                    negativePrompt: normalized.negativeTags,
                    characters: normalized.characters,
                    categories: normalized.categories,
                    memo: normalized.note,
                    seed: '',
                    steps: null,
                    guidance: null,
                    guidanceRescale: null,
                    width: null,
                    height: null,
                    sourceUrl: normalized.source?.url || ''
                };

                await naiNotionCreatePage(
                    token,
                    archive,
                    draft,
                    {
                        image: false,
                        basePrompt: true,
                        negativePrompt: true,
                        characterPrompt: true,
                        seed: false,
                        steps: false,
                        guidance: false,
                        guidanceRescale: false
                    },
                    null
                );

                existingKeys.add(key);
                migrated++;
            } catch (error) {
                console.warn(
                    `[${APP_NAME}] Legacy migration item failed`,
                    normalized?.name,
                    error
                );
                failed++;
            }
        }

        try {
            await naiNotionSyncPersonal({ force: true, quiet: true });
        } catch (_) {}

        let deleted = false;
        const complete = failed === 0 && migrated + existing === local.length;

        if (complete && offerDelete) {
            const shouldDelete = await naiNotionConfirmModal({
                title: '기존 라이브러리 백업 완료',
                message:
                    `기존 로컬 라이브러리 ${local.length}개를 모두 Notion으로 백업했습니다.\n\n` +
                    `기존 데이터를 삭제하시겠습니까?\n` +
                    `삭제하면 기존 라이브러리 아이콘도 사라집니다.`,
                confirmText: '기존 데이터 삭제',
                cancelText: '유지',
                danger: true
            });

            if (shouldDelete) {
                GM_deleteValue(LIBRARY_KEY);
                GM_deleteValue(LIBRARY_CATEGORY_KEY);
                naiNotionState.legacyExternalView = false;
                deleted = true;
            }
        }

        return {
            total: local.length,
            migrated,
            existing,
            failed,
            deleted
        };
    }

    function naiNotionSettingsHtml() {
        const token = naiNotionReadToken();
        const conn = naiNotionGetConnection();
        return `<div class="nai-loader-divider"></div><div class="nai-loader-section-title">Notion 라이브러리</div><div class="nai-loader-field"><label class="nai-loader-label">Notion API Token</label><input id="nai-notion-token-input" class="nai-loader-input" type="password" autocomplete="off" value="${escapeHtml(token)}" placeholder="ntn_... / secret_..."><div class="nai-loader-muted" style="margin-top:6px;">이 토큰은 현재 브라우저의 Tampermonkey 저장소에만 보관됩니다.</div></div><div class="nai-loader-row" style="flex-wrap:wrap;"><button type="button" class="nai-loader-action primary" data-nn-settings="connect">${token ? '연결 확인' : 'Notion 연결'}</button><button type="button" class="nai-loader-action" data-nn-settings="reset">연결 초기화</button><button type="button" class="nai-loader-action danger" data-nn-settings="delete-token">토큰 삭제</button></div><div class="nai-loader-muted" style="margin-top:6px;">“Notion 목록 불러오기”에서 Integration이 접근 가능한 DB를 불러오고, 체크한 DB만 내 라이브러리 저장소 목록에 표시할 수 있습니다. 기존 로컬 라이브러리가 남아 있으면 Notion 필터 옆 보관함 아이콘으로 표시됩니다.</div><div class="nai-loader-row" style="flex-wrap:wrap; margin-top:8px;"><button type="button" class="nai-loader-action" data-nn-settings="notion-list">Notion 목록 불러오기</button><button type="button" class="nai-loader-action" data-nn-settings="clear-cache">라이브러리 캐시 비우기</button></div><div class="nai-loader-status" data-nn-settings-status>${conn.dataSourceId ? `연결됨 · ${escapeHtml(conn.title || `Data Source ${conn.dataSourceId.slice(0,8)}…`)}` : '연결되지 않음'}</div>`;
    }

    function naiNotionMountSettings(overlay) {
        const panel = overlay?.querySelector('[data-panel="settings"]');
        if (!panel || panel.querySelector('[data-nn-settings-root]')) return;
        const root = document.createElement('div');
        root.dataset.nnSettingsRoot = '1';
        root.innerHTML = naiNotionSettingsHtml();
        panel.appendChild(root);
        root.addEventListener('click', async event => {
            const button = event.target.closest('[data-nn-settings]');
            if (!button) return;
            const status = root.querySelector('[data-nn-settings-status]');
            const action = button.dataset.nnSettings;
            try {
                if (action === 'connect') {
                    const input = root.querySelector('#nai-notion-token-input');
                    const value = input.value.trim();
                    if (!value) { status.textContent='Token을 입력해주세요.'; return; }
                    const old = naiNotionReadToken();
                    if (old !== value) { naiNotionSaveToken(value); naiNotionClearConnection(); }
                    status.textContent='Notion 연결을 확인하는 중…';
                    const archive = await naiNotionEnsureArchive(value, true);
                    naiNotionSaveAllDatabaseListCache([
                        ...naiNotionAllDatabaseListCache(),
                        archive
                    ]);
                    naiNotionSaveSelectedDataSourceIds([
                        ...naiNotionSelectedDataSourceIds(),
                        archive.dataSourceId
                    ]);
                    status.textContent=`연결 완료 · ${archive.title || archive.dataSourceId.slice(0,8) + '…'}`;
                    await naiNotionSyncPersonal({ quiet:true });
                } else if (action === 'reset') {
                    naiNotionClearConnection();
                    status.textContent='연결 정보만 초기화했습니다. Notion DB는 삭제되지 않았습니다.';
                } else if (action === 'delete-token') {
                    if (!confirm('현재 브라우저에 저장된 Notion Token을 삭제할까요?\nNotion DB 자체는 삭제되지 않습니다.')) return;
                    GM_deleteValue(NAI_NOTION.tokenKey); naiNotionClearConnection();
                    root.querySelector('#nai-notion-token-input').value=''; status.textContent='Token을 삭제했습니다.';
                } else if (action === 'notion-list') {
                    const input = root.querySelector('#nai-notion-token-input');
                    const value = input.value.trim() || naiNotionReadToken();
                    if (!value) {
                        status.textContent = 'Token을 먼저 입력해주세요.';
                        return;
                    }
                    if (value !== naiNotionReadToken()) {
                        naiNotionSaveToken(value);
                    }
                    status.textContent = 'Notion DB 목록 창을 여는 중…';
                    const managed = await naiNotionDatabaseManagerModal(
                        value,
                        { refreshOnOpen: true }
                    );
                    if (managed) {
                        status.textContent =
                            `접근 가능한 DB ${managed.total}개 · 표시 ${managed.selected}개`;
                    } else {
                        status.textContent = 'Notion DB 표시 설정을 닫았습니다.';
                    }
                } else if (action === 'clear-cache') {
                    GM_deleteValue(NAI_NOTION.cacheKey); GM_deleteValue(NAI_NOTION.cacheMapKey); naiNotionState.cache=null; await naiNotionThumbClear();
                    status.textContent='로컬 라이브러리 캐시를 비웠습니다. Notion 원본은 그대로입니다.';
                    naiNotionController?.renderLibraryPanel?.();
                }
            } catch (error) { status.textContent=naiNotionHumanizeError(error); }
        });
    }

    function naiNotionToast(message, error = false) {
        let toast = document.getElementById('nai-notion-global-toast');
        if (!toast) {
            toast = document.createElement('div'); toast.id='nai-notion-global-toast'; toast.className='nai-notion-global-toast'; document.body.appendChild(toast);
        }
        toast.textContent=String(message||''); toast.classList.toggle('error',!!error); toast.classList.add('show');
        clearTimeout(naiNotionToast._timer); naiNotionToast._timer=setTimeout(()=>toast.classList.remove('show'),3600);
    }

    function naiNotionMountArchiveModal(overlay) {
        if (!overlay || overlay.id !== MODAL_ID) return;
        naiNotionState.mountedOverlay=overlay;
        const panel=overlay.querySelector('[data-panel="library"]');
        if (panel) {
            naiNotionLibraryModeHeader(panel);
            if (!panel.dataset.nnBound) {
                panel.dataset.nnBound='1';
                panel.addEventListener('error', event => {
                    const img = event.target;
                    if (!(img instanceof HTMLImageElement)) return;
                    const original = String(img.dataset?.notionSrc || '');
                    if (!original || img.dataset.notionRetried === '1') return;
                    img.dataset.notionRetried = '1';
                    const sep = original.includes('?') ? '&' : '?';
                    img.src = `${original}${sep}_nai_retry=${Date.now()}`;
                }, true);

                panel.addEventListener('click', async event => {
                    const mode=event.target.closest('[data-nn-mode]');
                    if(mode){ naiNotionState.mode=mode.dataset.nnMode; naiNotionState.legacyExternalView=false; GM_setValue(NAI_NOTION.libraryModeKey,naiNotionState.mode); naiNotionController.renderLibraryPanel(); return; }
                    if(event.target.closest('[data-nn-archive-menu]')){ try{await naiNotionChoosePersonalArchive();}catch(e){naiNotionSetLibraryStatus(naiNotionHumanizeError(e),true);} return; }
                    if(event.target.closest('[data-nn-open-personal]')){ if(!naiNotionOpenCurrentDatabase()) naiNotionSetLibraryStatus('열 수 있는 Notion 저장소 URL이 없습니다.',true); return; }
                    if(event.target.closest('[data-nn-refresh]')){ naiNotionSyncPersonal({force:true}).catch(()=>{}); return; }
                    if(event.target.closest('[data-nn-connect]')){ try{const token=await naiNotionGetTokenInteractive(); if(token){await naiNotionEnsureArchive(token,true); await naiNotionSyncPersonal({force:true}); naiNotionController.renderLibraryPanel();}}catch(e){naiNotionSetLibraryStatus(naiNotionHumanizeError(e),true);} return; }

                    const legacy=event.target.closest('[data-nn-legacy]');
                    if(legacy){
                        const action=legacy.dataset.nnLegacy;
                        if(action==='open'){
                            if(!getLibrary().length)return;
                            naiNotionState.legacyExternalView=true;
                            naiNotionLibraryModeHeader(panel);
                            const search=panel.querySelector('#nai-library-search');
                            if(search){
                                search.value='';
                                search.placeholder='기존 로컬 라이브러리 검색';
                                search.dispatchEvent(new Event('input',{bubbles:true}));
                            }
                        } else if(action==='back'){
                            naiNotionState.legacyExternalView=false;
                            naiNotionState.personalCategory='';
                            naiNotionController.renderLibraryPanel();
                        } else if(action==='backup'){
                            if(legacy.dataset.busy==='1')return;
                            legacy.dataset.busy='1';
                            legacy.disabled=true;
                            const originalText=legacy.textContent;
                            legacy.textContent='백업 중…';
                            try{
                                const result=await naiNotionMigrateLegacyLibrary({offerDelete:true});
                                if(result.failed){
                                    naiNotionSetLibraryStatus(
                                        `백업 완료 · ${result.migrated}개 성공 · ${result.existing}개 기존 · ${result.failed}개 실패`,
                                        true
                                    );
                                } else if(result.deleted){
                                    naiNotionSetLibraryStatus(`백업 완료 · ${result.total}개 · 기존 데이터 삭제 완료`);
                                    naiNotionController.renderLibraryPanel();
                                } else {
                                    naiNotionSetLibraryStatus(
                                        `백업 완료 · ${result.migrated}개 추가 · ${result.existing}개 이미 백업됨`
                                    );
                                    naiNotionLibraryModeHeader(panel);
                                }
                            }catch(e){
                                naiNotionSetLibraryStatus(naiNotionHumanizeError(e),true);
                            }finally{
                                legacy.dataset.busy='0';
                                legacy.disabled=false;
                                if(legacy.isConnected)legacy.textContent=originalText;
                            }
                        }
                        return;
                    }

                    const favoriteFilter=event.target.closest('[data-nn-favorite-filter]');
                    if(favoriteFilter){
                        if(favoriteFilter.dataset.nnFavoriteFilter==='external'){
                            naiNotionState.externalFavoritesOnly=!naiNotionState.externalFavoritesOnly;
                        }else{
                            naiNotionState.personalFavoritesOnly=!naiNotionState.personalFavoritesOnly;
                        }
                        naiNotionController.renderLibraryPanel();
                        return;
                    }

                    const favoriteItem=event.target.closest('[data-nn-favorite-item]');
                    if(favoriteItem){
                        if(favoriteItem.dataset.nnFavoriteItem==='external'){
                            const sources=naiNotionGetExternalSources();
                            const allItems=sources.flatMap(s=>[
                                ...(Array.isArray(s.items)?s.items:[]),
                                ...(Array.isArray(s.databases)?s.databases.flatMap(db=>Array.isArray(db.items)?db.items:[]):[])
                            ]);
                            const item=allItems.find(x=>String(x.id)===String(favoriteItem.dataset.nnId));
                            if(item){
                                const active=naiNotionToggleFavorite(item);
                                naiNotionSetLibraryStatus(active?`“${item.name}” 즐겨찾기 추가`:`“${item.name}” 즐겨찾기 해제`);
                                naiNotionController.renderLibraryPanel();
                            }
                        }else{
                            const item=(naiNotionCurrentCache().items||[]).find(x=>String(x._notionPageId||x.id)===String(favoriteItem.dataset.nnId));
                            if(item){
                                const active=naiNotionToggleFavorite(item);
                                naiNotionSetLibraryStatus(active?`“${item.name}” 즐겨찾기 추가`:`“${item.name}” 즐겨찾기 해제`);
                                naiNotionController.renderLibraryPanel();
                            }
                        }
                        return;
                    }

                    const cat=event.target.closest('[data-nn-category]');
                    if(cat){
                        const category = cat.dataset.nnCategory || '';
                        if(
                            naiNotionState.mode === 'personal' &&
                            naiNotionState.legacyExternalView &&
                            category === ''
                        ){
                            naiNotionState.legacyExternalView = false;
                        }
                        naiNotionState.personalCategory = category;
                        naiNotionController.renderLibraryPanel();
                        return;
                    }
                    const detail=event.target.closest('[data-nn-detail]'); if(detail){const item=(naiNotionCurrentCache().items||[]).find(x=>(x._notionPageId||x.id)===detail.dataset.nnDetail); if(item) naiNotionDetailModal(item); return;}

                    const personalBaseMode=event.target.closest('[data-nn-personal-base-mode]');
                    if(personalBaseMode){
                        const item=(naiNotionCurrentCache().items||[]).find(x=>(x._notionPageId||x.id)===personalBaseMode.dataset.nnId);
                        if(!item)return;
                        naiNotionSetPersonalBaseMode(item, personalBaseMode.dataset.nnPersonalBaseMode);
                        const segment=personalBaseMode.closest('.nai-notion-segment');
                        segment?.querySelectorAll('button').forEach(button=>{
                            button.classList.toggle('active',button===personalBaseMode);
                        });
                        return;
                    }

                    const referenceImage=event.target.closest('[data-nn-reference-image]');
                    if(referenceImage){
                        const item=(naiNotionCurrentCache().items||[]).find(x=>(x._notionPageId||x.id)===referenceImage.dataset.nnId);
                        if(!item)return;
                        try{
                            naiNotionSetLibraryStatus(`“${item.name}” 로컬 레퍼런스 이미지 선택 중…`);
                            const selected=await naiNotionChooseLocalReferenceImage(item);
                            if(!selected){
                                naiNotionSetLibraryStatus('레퍼런스 이미지 선택을 취소했습니다.');
                                return;
                            }
                            naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 이미지 적용 중…`);
                            await naiNotionApplyPreciseReference(item,naiNotionGetReferencePreset(item));
                            naiNotionSetLibraryStatus(`“${item.name}” 로컬 레퍼런스 ON`);
                            naiNotionScheduleNativeReferenceInsert();
                            naiNotionController.renderLibraryPanel();
                        }catch(error){
                            naiNotionSetLibraryStatus(naiNotionHumanizeError(error),true);
                        }
                        return;
                    }

                    const referenceToggle=event.target.closest('[data-nn-reference-toggle]');
                    if(referenceToggle){
                        const item=(naiNotionCurrentCache().items||[]).find(x=>(x._notionPageId||x.id)===referenceToggle.dataset.nnId);
                        if(!item)return;
                        try{
                            if(referenceToggle.dataset.nnReferenceToggle==='on'){
                                naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 이미지 준비 중…`);
                                await naiNotionApplyPreciseReference(item,naiNotionGetReferencePreset(item));
                                naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 ON`);
                                naiNotionScheduleNativeReferenceInsert();
                            }else{
                                await naiNotionDisablePreciseReference(item);
                                naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 OFF`);
                            }
                            naiNotionController.renderLibraryPanel();
                        }catch(error){
                            naiNotionSetLibraryStatus(naiNotionHumanizeError(error),true);
                        }
                        return;
                    }

                    const action=event.target.closest('[data-nn-action]'); if(action){const item=(naiNotionCurrentCache().items||[]).find(x=>(x._notionPageId||x.id)===action.dataset.nnId); if(!item)return; if(action.dataset.nnAction==='copy'){const ok=await copyText(item.tags||''); naiNotionSetLibraryStatus(ok?'Base Prompt를 복사했습니다.':'복사에 실패했습니다.',!ok);} else if(action.dataset.nnAction==='use'){naiNotionSetLibraryStatus('NovelAI에 적용하는 중…'); const res=await naiNotionReplaceConceptInNovelAI(item,naiNotionGetPersonalBaseMode(item)); naiNotionSetLibraryStatus(res.ok?`“${item.name}” 적용 완료`:res.error,!res.ok);} return;}
                    const extPref=event.target.closest('[data-nn-ext-pref]');
                    if(extPref){
                        const sourceId=extPref.dataset.nnSourceId||'';
                        const dbId=extPref.dataset.nnDbId||'';
                        const field=extPref.dataset.nnExtPref;
                        const value=extPref.dataset.value;
                        if(field==='applyTarget' && (value==='base'||value==='character')){
                            naiNotionUpdateExternalApplyPref(sourceId,dbId,'applyTarget',value);
                            naiNotionController.renderLibraryPanel();
                        } else if(field==='baseMode' && (value==='append'||value==='replace')){
                            naiNotionUpdateExternalApplyPref(sourceId,dbId,'baseMode',value);
                            naiNotionController.renderLibraryPanel();
                        }
                        return;
                    }

                    const ext=event.target.closest('[data-nn-ext]');
                    if(ext){
                        const type=ext.dataset.nnExt; const id=ext.dataset.nnSourceId; const dbId=ext.dataset.nnDbId;
                        const sources=naiNotionGetExternalSources(); const source=sources.find(x=>x.id===id);
                        if(type==='add'){
                            const created=await naiNotionAddExternalModal();
                            if(created){created.databases=[];created.selectedDatabaseId='';sources.push(created);naiNotionSaveExternalSources(sources);naiNotionState.externalSourceId=created.id;naiNotionController.renderLibraryPanel();naiNotionSyncExternalSource(created.id);}
                        } else if(type==='sync'&&source) naiNotionSyncExternalSource(id);
                        else if(type==='sync-db'&&source&&dbId) naiNotionSyncExternalSource(id,dbId);
                        else if(type==='choose-db'&&source){
                            const chosen=await naiNotionExternalDatabaseModal(source);
                            if(chosen){
                                const latest=naiNotionGetExternalSources(); const sourceIndex=latest.findIndex(x=>x.id===id);
                                if(sourceIndex>=0){latest[sourceIndex]={...latest[sourceIndex],selectedDatabaseId:String(chosen.id),items:Array.isArray(chosen.items)?chosen.items:[]};naiNotionSaveExternalSources(latest);}
                                naiNotionController.renderLibraryPanel();
                                if(!chosen.lastSync) naiNotionSyncExternalSource(id,String(chosen.id));
                            }
                        } else if(type==='open'&&source) window.open(source.url,'_blank','noopener,noreferrer');
                        else if(type==='remove'&&source){if(confirm(`“${source.name}” 외부 라이브러리를 삭제할까요?
Notion 원본은 삭제되지 않습니다.`)){naiNotionSaveExternalSources(sources.filter(x=>x.id!==id));if(naiNotionState.externalSourceId===id)naiNotionState.externalSourceId='';naiNotionController.renderLibraryPanel();}}
                        else if(type==='select'){naiNotionState.externalSourceId=id;naiNotionController.renderLibraryPanel();}
                        return;
                    }
                    const externalItems=()=>{const sources=naiNotionGetExternalSources();return sources.flatMap(s=>[...(Array.isArray(s.items)?s.items:[]),...(Array.isArray(s.databases)?s.databases.flatMap(db=>Array.isArray(db.items)?db.items:[]):[])]);};
                    const extReferenceImage=event.target.closest('[data-nn-ext-reference-image]');
                    if(extReferenceImage){
                        const item=externalItems().find(x=>x.id===extReferenceImage.dataset.nnId);
                        if(!item)return;
                        try{
                            naiNotionSetLibraryStatus(`“${item.name}” 로컬 레퍼런스 이미지 선택 중…`);
                            const selected=await naiNotionChooseLocalReferenceImage(item);
                            if(!selected){naiNotionSetLibraryStatus('레퍼런스 이미지 선택을 취소했습니다.');return;}
                            naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 이미지 적용 중…`);
                            await naiNotionApplyPreciseReference(item,naiNotionGetReferencePreset(item));
                            naiNotionSetLibraryStatus(`“${item.name}” 로컬 레퍼런스 ON`);
                            naiNotionScheduleNativeReferenceInsert();
                            naiNotionController.renderLibraryPanel();
                        }catch(error){naiNotionSetLibraryStatus(naiNotionHumanizeError(error),true);}
                        return;
                    }
                    const extReferenceToggle=event.target.closest('[data-nn-ext-reference-toggle]');
                    if(extReferenceToggle){
                        const item=externalItems().find(x=>x.id===extReferenceToggle.dataset.nnId);
                        if(!item)return;
                        try{
                            if(extReferenceToggle.dataset.nnExtReferenceToggle==='on'){
                                naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 이미지 준비 중…`);
                                await naiNotionApplyPreciseReference(item,naiNotionGetReferencePreset(item));
                                naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 ON`);
                                naiNotionScheduleNativeReferenceInsert();
                            }else{
                                await naiNotionDisablePreciseReference(item);
                                naiNotionSetLibraryStatus(`“${item.name}” 레퍼런스 OFF`);
                            }
                            naiNotionController.renderLibraryPanel();
                        }catch(error){naiNotionSetLibraryStatus(naiNotionHumanizeError(error),true);}
                        return;
                    }
                    const extDetail=event.target.closest('[data-nn-ext-detail]'); if(extDetail){const item=externalItems().find(x=>x.id===extDetail.dataset.nnExtDetail); if(item) naiNotionExternalDetailModal(item); return;}
                    const extAction=event.target.closest('[data-nn-ext-action]'); if(extAction){const item=externalItems().find(x=>x.id===extAction.dataset.nnId); if(!item)return; if(extAction.dataset.nnExtAction==='copy'){const ok=await copyText(naiNotionExternalCharacterCopyText(item)); naiNotionSetLibraryStatus(ok?'Character Prompt를 복사했습니다.':'복사에 실패했습니다.',!ok);} else if(extAction.dataset.nnExtAction==='use'){const res=await naiNotionUseExternalPreset(item); if(res.cancelled)return; naiNotionSetLibraryStatus(res.ok?`“${item.name}” 적용 완료`:res.error,!res.ok);} return;}
                });
            }
        }
        naiNotionMountSettings(overlay);

        if (
            panel &&
            naiNotionState.mode === 'external' &&
            !overlay.dataset.nnExternalInitialPaint
        ) {
            overlay.dataset.nnExternalInitialPaint = '1';
            requestAnimationFrame(() => {
                if (
                    overlay.isConnected &&
                    naiNotionState.mode === 'external'
                ) {
                    naiNotionRenderExternal(panel);
                }
            });
        }

        if (!overlay.dataset.nnInitialSync) {
            overlay.dataset.nnInitialSync = '1';
            const token = naiNotionReadToken();
            const conn = naiNotionGetConnection();
            const cache = naiNotionCurrentCache();
            if (token && conn.dataSourceId && (Date.now() - Number(cache.lastSync || 0) > 30000)) {
                naiNotionSyncPersonal({ quiet: true }).catch(() => {});
            }
        }
    }

    naiNotionController = {
        shouldHandleLibraryRender() {
            if (naiNotionState.mode === 'personal') {
                return !naiNotionState.legacyExternalView;
            }
            if (naiNotionState.mode === 'external') return true;
            return false;
        },
        async renderLibraryPanel() {
            const overlay=document.getElementById(MODAL_ID); if(!overlay)return;
            naiNotionMountArchiveModal(overlay);
            const panel=overlay.querySelector('[data-panel="library"]'); if(!panel)return;
            naiNotionLibraryModeHeader(panel);
            if(naiNotionState.mode==='personal' && naiNotionState.legacyExternalView) {
                // Reuse the original local-library renderer verbatim.
                const add=panel.querySelector('[data-create-toggle="library"]'); if(add)add.hidden=false;
                const createWrap=panel.querySelector('#nai-library-create-wrap'); if(createWrap)createWrap.hidden=true;
                const search=panel.querySelector('#nai-library-search');
                naiNotionLibraryModeHeader(panel);
                if(search){
                    search.placeholder='기존 로컬 라이브러리 검색';
                    search.dispatchEvent(new Event('input',{bubbles:true}));
                }
            } else if(naiNotionState.mode==='personal') {
                naiNotionRenderPersonal(panel);
            } else {
                naiNotionState.legacyExternalView=false;
                naiNotionRenderExternal(panel);
            }
        },
        mountArchiveModal: naiNotionMountArchiveModal,
        openSaveFlow: naiNotionOpenSaveFlow,
        syncPersonal: naiNotionSyncPersonal,
        toast: naiNotionToast
    };

    GM_addStyle(`
      .nai-notion-small-modal{width:min(620px,calc(100vw - 28px));height:auto;max-height:min(82vh,720px)}
      .nai-notion-save-modal{width:min(720px,calc(100vw - 28px));height:auto;max-height:calc(100vh - 36px)}
      .nai-notion-detail-modal{width:min(820px,calc(100vw - 28px))}
      .nai-toolbar-search-button{display:inline-flex;align-items:center;justify-content:center;width:34px;min-width:34px;padding:0}.nai-toolbar-search-button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.nai-notion-external-detail-footer{display:flex!important;justify-content:flex-end!important;margin-top:12px!important}
      .nai-notion-library-modes{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.nai-notion-mode-tabs,.nai-notion-mode-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.nai-notion-mode-actions [data-nn-archive-menu]{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .nai-notion-legacy-heading{font-size:11px;color:#aeb3cc;padding:0 2px}
      #nai-library-category-bar .nai-category-chip{appearance:none;border:1px solid #3b3f5b;background:#202235;color:#b8bdd9;border-radius:999px;padding:5px 10px;font:inherit;font-size:11px;line-height:1.1;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease}
      #nai-library-category-bar .nai-category-chip:hover{border-color:#7562b8;color:#ddd5ff}
      #nai-library-category-bar .nai-category-chip.active{border-color:#8d6cf0;background:#7654da;color:#fff}
      .nai-notion-legacy-icon{appearance:none;width:29px;height:29px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid #464a68;border-radius:8px;background:#202235;color:#aa91ff;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease,transform .15s ease;vertical-align:middle}
      .nai-notion-legacy-icon:hover{border-color:#8064d9;background:#292744;color:#c4b1ff;transform:translateY(-1px)}
      .nai-notion-legacy-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .nai-notion-connect-empty{min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:10px;border:1px dashed #444865;border-radius:8px;padding:24px}.nai-notion-connect-empty span{color:#9ea3bf;max-width:420px}
      .nai-notion-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.nai-notion-card{position:relative;overflow:hidden;border:1px solid #353850;border-radius:8px;background:#181a2a}.nai-notion-card-image{display:block;width:100%;aspect-ratio:1/1;border:0;padding:0;background:#11131e;cursor:pointer;overflow:hidden}.nai-notion-card-image img{width:100%;height:100%;object-fit:cover;display:block}.nai-notion-no-image{display:flex;width:100%;height:100%;align-items:center;justify-content:center;color:#676c88;font-size:12px}.nai-notion-card-body{padding:10px}.nai-notion-card-title{display:block;width:100%;border:0;background:transparent;color:#fff;text-align:left;font:inherit;font-weight:700;padding:0;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nai-notion-card-cats{display:flex;gap:4px;flex-wrap:wrap;margin-top:7px;min-height:18px}.nai-notion-card-cats span{font-size:10px}.nai-notion-card-cats span{padding:2px 6px;border:1px solid #424665;border-radius:999px;color:#b8bdd9}.nai-notion-card-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:9px}
      .nai-notion-card-favorite,.nai-notion-favorite-filter{appearance:none;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:29px;height:29px;min-width:29px;padding:0;border:1px solid #464a68;border-radius:8px;background:#202235;color:#9b9fb8;cursor:pointer;transition:border-color .15s ease,background .15s ease,color .15s ease,transform .15s ease}
      .nai-notion-card-favorite{position:absolute;top:8px;right:8px;z-index:3;background:rgba(24,26,42,.88);backdrop-filter:blur(3px)}
      .nai-notion-card-favorite:hover,.nai-notion-favorite-filter:hover{border-color:#8b6ff0;color:#c6b5ff;transform:translateY(-1px)}
      .nai-notion-card-favorite.active,.nai-notion-favorite-filter.active{border-color:#9a74ff;background:#6f52cf;color:#fff}
      .nai-notion-card-favorite svg,.nai-notion-favorite-filter svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
      .nai-notion-card-favorite.active svg,.nai-notion-favorite-filter.active svg{fill:currentColor}
      #nai-library-category-bar .nai-notion-favorite-filter{margin-left:auto}
      .nai-notion-source-tabs{align-items:center;width:100%}.nai-notion-source-tabs .nai-notion-favorite-filter{margin-left:auto}
      .nai-notion-card-pref{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:8px;color:#8f94af;font-size:10px}
      .nai-notion-segment{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid #3c405b;border-radius:7px;background:#131522}
      .nai-notion-segment>button{appearance:none;border:0;border-radius:5px;background:transparent;color:#858aa6;padding:4px 7px;font:inherit;font-size:10px;line-height:1;cursor:pointer;white-space:nowrap}
      .nai-notion-segment>button:hover:not(:disabled){color:#d9d2f9;background:#24263b}
      .nai-notion-segment>button.active{background:#7654da;color:#fff}
      .nai-notion-segment.disabled{opacity:.38}.nai-notion-segment>button:disabled{cursor:default}
      .nai-notion-pref-label{font-size:10px;color:#8f94af;white-space:nowrap}.nai-notion-pref-label.disabled{opacity:.38}
      .nai-notion-external-apply-prefs{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;margin-left:auto}
      .nai-notion-choice-list{display:grid;gap:8px}.nai-notion-choice{display:flex;flex-direction:column;gap:3px;text-align:left;padding:11px;border:1px solid #3d405c;border-radius:6px;background:#181a2a;color:#fff;cursor:pointer}.nai-notion-choice:hover{border-color:#8064d9}.nai-notion-choice span{font-size:10px;color:#858aa6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .nai-notion-save-preview,.nai-notion-detail-image{display:flex;justify-content:center;margin-bottom:10px}.nai-notion-save-preview img{max-width:100%;max-height:260px;object-fit:contain;border-radius:6px}.nai-notion-detail-image img{max-width:100%;max-height:440px;object-fit:contain;border-radius:6px}.nai-notion-check-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 18px;padding:12px;border:1px solid #353850;border-radius:6px;background:#181a2a}.nai-notion-check-grid>.nai-notion-check-item{display:flex!important;align-items:center!important;justify-content:flex-start!important;gap:8px!important;min-width:0;margin:0!important;padding:0!important;color:#e7e9f4;font-size:12px;line-height:1.2;cursor:pointer}.nai-notion-check-grid>.nai-notion-check-item>input{flex:0 0 auto!important;width:14px!important;height:14px!important;margin:0!important;padding:0!important}.nai-notion-check-grid>.nai-notion-check-item>span{display:block!important;min-width:0;white-space:nowrap}
      .nai-notion-detail-actions{display:flex!important;align-items:center!important;justify-content:flex-end!important;gap:5px!important;flex-wrap:wrap;margin-top:0!important;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #30334a}
      .nai-notion-detail-actions .nai-loader-action{flex:0 0 auto!important;margin:0!important}
      .nai-notion-reference-icon{width:30px!important;min-width:30px!important;height:30px!important;min-height:30px!important;padding:0!important;display:inline-flex!important;align-items:center!important;justify-content:center!important;color:#b8bdd9}.nai-notion-reference-icon svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}.nai-notion-reference-icon.active,.nai-notion-reference-text.active{border-color:#8d6cf0!important;background:#30294a!important;color:#c9b8ff!important;box-shadow:0 0 0 1px rgba(141,108,240,.16) inset}.nai-notion-reference-icon:disabled,.nai-notion-reference-text:disabled{opacity:.35!important;cursor:default!important}.nai-notion-reference-row{margin-top:5px!important}.nai-notion-reference-row .nai-notion-segment button:disabled{opacity:.35;cursor:default}
      .nai-notion-reference-modal{width:min(540px,calc(100vw - 28px));height:auto;max-height:min(760px,calc(100vh - 28px))}.nai-notion-reference-preview{display:flex;align-items:center;justify-content:center;min-height:84px;max-height:250px;margin-bottom:14px;border:1px solid #30334a;border-radius:8px;background:#11131e;overflow:hidden}.nai-notion-reference-preview:empty{display:none}.nai-notion-reference-preview img{max-width:100%;max-height:250px;object-fit:contain}.nai-notion-reference-types{display:flex;gap:6px;flex-wrap:wrap}.nai-notion-reference-types .nai-loader-action.active{border-color:#8d6cf0!important;background:#7654da!important;color:#fff!important}.nai-notion-reference-control{display:grid;gap:7px;margin-top:14px;padding:10px 12px;border:1px solid #353850;border-radius:8px;background:#181a2a}.nai-notion-reference-control-head{display:flex;align-items:center;justify-content:space-between;gap:12px;color:#e7e9f4;font-size:12px;font-weight:700}.nai-notion-reference-control-head input[type=number]{width:76px;border:1px solid #41455f;border-radius:6px;background:#11131e;color:#fff;padding:5px 7px;font:inherit;text-align:right}.nai-notion-reference-control input[type=range]{width:100%;accent-color:#8d6cf0}.nai-notion-reference-actions{justify-content:flex-end!important;align-items:center!important;gap:7px!important;flex-wrap:wrap;margin-top:16px!important}.nai-notion-reference-actions [data-ref-status]{margin-right:auto;max-width:240px}
      .nai-notion-save-actions{justify-content:flex-end!important;flex-wrap:wrap}
      .nai-notion-inline-status{display:inline-flex;align-items:center;min-height:22px;margin:0;color:#aeb3cc;font-size:11px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
      .nai-notion-inline-status:empty{display:none}
      .nai-notion-detail-actions .nai-notion-inline-status{margin:0 2px}
      .nai-notion-confirm-modal{width:min(460px,calc(100vw - 28px));height:auto;min-height:0;max-height:none}.nai-notion-confirm-modal>.nai-loader-content{flex:0 0 auto;min-height:0;overflow:visible}.nai-notion-confirm-modal .nai-loader-panel{padding:14px 18px 16px}.nai-notion-confirm-message{padding:4px 2px 12px;color:#e7e9f4;font-size:13px;line-height:1.6;white-space:normal}.nai-notion-confirm-actions{display:flex;align-items:center;justify-content:flex-end;gap:7px}
      .nai-notion-db-manager-modal{width:min(680px,calc(100vw - 28px));max-height:min(760px,calc(100vh - 28px))}.nai-notion-db-manager-toolbar{align-items:center;gap:7px}.nai-notion-db-manager-list{display:flex;flex-direction:column;gap:6px;max-height:430px;overflow:auto;padding:2px 3px 2px 0}.nai-notion-db-choice{display:flex;align-items:center;gap:10px;padding:10px 11px;border:1px solid #343850;border-radius:8px;background:#181a2a;color:#e7e9f4;cursor:pointer;transition:border-color .15s ease,background .15s ease}.nai-notion-db-choice:hover{border-color:#68599f;background:#1d1f32}.nai-notion-db-choice>input{flex:0 0 auto;width:15px;height:15px;margin:0}.nai-notion-db-choice-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.nai-notion-db-choice-main strong{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nai-notion-db-choice-main small{font-size:10px;color:#858ba8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nai-notion-db-current{flex:0 0 auto;padding:3px 6px;border-radius:999px;background:#30294a;color:#bca8ff;font-size:9px;font-weight:700}
      .nai-notion-external-db-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;margin:10px 0}.nai-notion-external-bulk-sync{display:flex;align-items:center;gap:8px;margin-bottom:12px}.nai-notion-external-bulk-sync .nai-notion-inline-status{font-size:10px;color:#9b9fba}.nai-notion-external-bulk-sync .nai-notion-inline-status.error{color:#ff6f7d}.nai-notion-external-db-choice small.error{color:#ff6f7d}.nai-notion-external-db-list{display:flex;flex-direction:column;gap:12px}.nai-notion-external-db-group{display:flex;flex-direction:column;gap:6px}.nai-notion-external-db-group-title{font-size:11px;font-weight:800;color:#c9c1ec;padding:0 2px}.nai-notion-external-db-group-rows{display:flex;flex-direction:column;gap:6px}.nai-notion-external-db-choice{appearance:none;width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;border:1px solid #343850;border-radius:8px;background:#181a2a;color:#e7e9f4;padding:10px 11px;cursor:pointer}.nai-notion-external-db-choice:hover,.nai-notion-external-db-choice.active{border-color:#7f66d4;background:#211f37}.nai-notion-external-db-choice>span:first-child{display:flex;flex-direction:column;gap:3px;min-width:0}.nai-notion-external-db-choice strong{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nai-notion-external-db-choice small{font-size:10px;color:#858ba8}

      .nai-notion-external-manager{display:grid;gap:8px}.nai-notion-external-source{display:flex;flex-direction:column;gap:4px;border:1px solid #353850;border-radius:7px;padding:10px}.nai-notion-external-source-top{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}.nai-notion-external-source-top>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.nai-notion-external-source-bottom{display:flex;align-items:center;gap:8px;min-height:13px;min-width:0}.nai-notion-external-meta{font-size:10px;color:#858aa6;white-space:nowrap;flex:0 0 auto}.nai-notion-external-inline-status{font-size:10px;color:#9b9fba;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.nai-notion-external-inline-status.error{color:#ff6f7d}.nai-notion-external-inline-status[hidden]{display:none!important}.nai-notion-external-actions,.nai-notion-external-bottom,.nai-notion-source-tabs{display:flex;gap:5px;flex-wrap:wrap}.nai-notion-sync-icon{min-width:34px}.nai-notion-external-use-options{display:grid;gap:8px}.nai-notion-external-use-options .nai-loader-action{height:auto;min-height:58px;display:flex;flex-direction:column;align-items:flex-start;justify-content:center;text-align:left;gap:3px;padding:10px 12px}.nai-notion-external-use-options .nai-loader-action strong{font-size:13px}.nai-notion-external-use-options .nai-loader-action span{font-size:11px;opacity:.72;font-weight:400;white-space:normal}.nai-notion-external-bottom{margin-top:4px}.nai-notion-external-gallery{margin-top:10px}.nai-notion-card-image-empty{cursor:default!important}.nai-notion-meta-row{gap:10px;flex-wrap:wrap;color:#aeb3cc;font-size:11px}
      .nai-notion-global-toast{position:fixed;left:50%;bottom:28px;z-index:1000003;transform:translate(-50%,14px);opacity:0;pointer-events:none;padding:10px 14px;border-radius:7px;background:#202234;color:#fff;border:1px solid #494d6d;box-shadow:0 12px 36px rgba(0,0,0,.45);transition:.18s ease;max-width:min(520px,calc(100vw - 28px));text-align:center}.nai-notion-global-toast.show{opacity:1;transform:translate(-50%,0)}.nai-notion-global-toast.error{border-color:#a64d59;color:#ffd4d8}
      @media(max-width:560px){.nai-notion-gallery{grid-template-columns:repeat(2,minmax(0,1fr))}.nai-notion-check-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 10px}.nai-notion-check-grid>.nai-notion-check-item{font-size:11px}.nai-notion-external-source-top{align-items:flex-start;flex-wrap:wrap}.nai-notion-external-source-bottom{flex-wrap:wrap}}@media(max-width:380px){.nai-notion-check-grid{grid-template-columns:1fr}}
    `);

    let naiNotionUiFrame = 0;
    const naiNotionUiObserver = new MutationObserver(() => {
        if (naiNotionUiFrame) return;
        naiNotionUiFrame = requestAnimationFrame(() => {
            naiNotionUiFrame = 0;
            naiNotionInsertButton();
        });
    });
    naiNotionUiObserver.observe(document.documentElement, { childList: true, subtree: true });
    naiNotionInsertButton();


    let injectionFrame = null;

    const observer = new MutationObserver(() => {
        if (injectionFrame) {
            cancelAnimationFrame(injectionFrame);
        }

        injectionFrame = requestAnimationFrame(() => {
            injectionFrame = null;
            injectNavbarButton();
        });
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    injectNavbarButton();
})();

    
