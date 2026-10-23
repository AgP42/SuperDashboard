import {NativeModules} from 'react-native';
import {PluginCommAPI, PluginManager} from 'sn-plugin-lib';
import {addClip, updateClipText} from '../src/clips';

jest.mock('../App', () => 'App');
jest.mock('../src/route', () => ({setRoute: jest.fn()}));
jest.mock('../src/bubble', () => ({
  showBubbleFromConfig: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/config', () => ({
  hasSavedConfig: jest.fn().mockResolvedValue(true),
  loadConfig: jest.fn().mockResolvedValue({clipText: 'ocr', clipFrame: 'off'}),
}));
jest.mock('../src/permissions', () => ({
  ensureFilePermissions: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/clips', () => ({
  addClip: jest.fn().mockResolvedValue(undefined),
  clipId: () => 'test-clip',
  nextMarkNum: jest.fn(),
  updateClipText: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/underline', () => ({
  detectUnderlineLabels: jest.fn().mockResolvedValue(['CONFIDENTIAL_LABEL']),
}));
jest.mock('../src/notepage', () => ({
  pageIdAt: jest.fn().mockResolvedValue('page-id'),
}));
jest.mock('../src/paths', () => ({
  cacheDir: jest.fn().mockResolvedValue('/private/plugin/'),
}));
jest.mock('../src/fonts/dseg7', () => ({
  DIGITAL_FONT: 'Digital',
  DSEG7_BOLD_B64: '',
}));
jest.mock('sn-plugin-lib', () => ({
  PluginManager: {
    init: jest.fn(),
    getPluginDirPath: jest.fn().mockResolvedValue('/private/plugin/'),
    registerPluginLifeListener: jest.fn(),
    registerButton: jest.fn(),
    registerButtonListener: jest.fn(),
  },
  PluginCommAPI: {
    getCurrentFilePath: jest.fn().mockResolvedValue({
      success: true,
      result: '/storage/emulated/0/Note/CONFIDENTIAL_TITLE.note',
    }),
    getCurrentPageNum: jest.fn().mockResolvedValue({success: true, result: 1}),
    getLassoElements: jest.fn(),
    getPageDisplaySize: jest.fn().mockResolvedValue({
      success: true,
      result: {width: 1404, height: 1872},
    }),
    saveStickerByLasso: jest.fn().mockResolvedValue({success: true}),
    getStickerSize: jest.fn().mockResolvedValue({
      success: true,
      result: {width: 200, height: 100},
    }),
    generateStickerThumbnail: jest.fn().mockResolvedValue(undefined),
    setLassoBoxState: jest.fn().mockResolvedValue(undefined),
    recognizeElements: jest.fn(),
  },
  PluginNoteAPI: {},
  PluginDocAPI: {},
}));

test('OCR capture saves content without putting text, labels, or its source path in diagnostics', async () => {
  jest.useFakeTimers();
  const text = 'CONFIDENTIAL_OCR_CONTENT';
  const recycle = jest.fn();
  const appendLog = jest.fn().mockResolvedValue(true);
  NativeModules.DashboardNative = {
    appendLog,
    clearAllBubbles: jest.fn().mockResolvedValue(true),
    cleanupOldVersions: jest.fn().mockResolvedValue(true),
  };
  PluginCommAPI.getLassoElements.mockResolvedValue({
    success: true,
    result: [{type: 0, recycle}],
  });
  PluginCommAPI.recognizeElements.mockResolvedValue({success: true, result: text});

  try {
    require('../index');
    const listener = PluginManager.registerButtonListener.mock.calls[0][0];
    listener.onButtonPress({id: 200});
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }

    expect(addClip).toHaveBeenCalledWith(
      expect.objectContaining({labels: ['CONFIDENTIAL_LABEL'], sourcePage: 1}),
    );
    expect(updateClipText).toHaveBeenCalledWith('test-clip', text);
    expect(recycle).toHaveBeenCalledTimes(1);
    const logs = appendLog.mock.calls.map(([message]) => message).join('\n');
    expect(logs).toContain(`[clip] ocr ok test-clip (${text.length} chars)`);
    expect(logs).toContain('labels=1');
    expect(logs).not.toContain(text);
    expect(logs).not.toContain('CONFIDENTIAL_LABEL');
    expect(logs).not.toContain('CONFIDENTIAL_TITLE');
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
