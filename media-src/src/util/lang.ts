const Langs = {
  en_US: {
    save: 'Save',
    wikiFile: 'Wiki File',
    wikiPages: 'Wiki Pages',
    navigateBack: 'Go Back',
    editInVsCode: 'Edit In VS Code',
    alignLeft: 'Left',
    alignCenter: 'Center',
    alignRight: 'Right',
    insertRowAbove: 'Insert 1 above',
    insertRowBelow: 'Insert 1 below',
    insertColumnLeft: 'Insert 1 left',
    insertColumnRight: 'Insert 1 right',
    deleteRow: 'Delete Row',
    deleteColumn: 'Delete Column',
    horizontalRule: 'Horizontal Rule',
    numberedList: 'Numbered List',
    undo: 'Undo',
    redo: 'Redo',
    settings: 'Settings',
    aboutVditor: 'About Vditor',
    aboutVmde: 'About VMDE',
    callout: 'Callout',
    toggleDetails: 'Toggle details around selected blocks',
    subscript: 'Subscript',
    superscript: 'Superscript',
    underline: 'Underline',
    math: 'Math',
    inlineMathGithub: 'Inline math (GitHub)',
    mathBlock: 'Math block',
    insertAnchor: 'Insert anchor',
    insertPicture: 'Insert picture',
  },
  ja_JP: {
    save: '保存する',
  },
  ko_KR: {
    save: '저장',
  },
  zh_CN: {
    save: '保存',
    wikiFile: 'Wiki 文件',
    wikiPages: 'Wiki 页面',
    navigateBack: '返回',
    editInVsCode: '在 VS Code 中编辑',
    alignLeft: '左对齐',
    alignCenter: '居中',
    alignRight: '右对齐',
    insertRowAbove: '向上插入一行',
    insertRowBelow: '向下插入一行',
    insertColumnLeft: '向左插入一列',
    insertColumnRight: '向右插入一列',
    deleteRow: '删除行',
    deleteColumn: '删除列',
    horizontalRule: '分隔线',
    numberedList: '有序列表',
    undo: '撤销',
    redo: '重做',
    settings: '设置',
    aboutVditor: '关于 Vditor',
    aboutVmde: '关于 VMDE',
    callout: '标注',
    toggleDetails: '切换所选块的详细信息',
    subscript: '下标',
    superscript: '上标',
    underline: '下划线',
    math: 'Math',
    inlineMathGithub: 'Inline math (GitHub)',
    mathBlock: 'Math block',
  },
}

type LangKey = keyof typeof Langs
const LangsIndexed = Langs as Record<string, Record<string, string>>

export const lang: LangKey = (() => {
  const l = navigator.language.replace('-', '_')
  return (l in Langs ? l : 'en_US') as LangKey
})()

export function translate(msg: string, locale: LangKey = lang) {
  const localized = LangsIndexed[locale]
  return localized?.[msg] || LangsIndexed.en_US[msg]
}

export function t(msg: string) {
  return translate(msg)
}
