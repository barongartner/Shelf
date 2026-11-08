'use strict';

// The "Shelf" iPhone Shortcut that puts Shelf in the share sheet. It holds
// no key: when it is added, Shortcuts asks for the share address (the phone
// copies it from Settings first) and keeps it in the Text action at the top.
// For each shared thing it posts the thing as the raw body to that address,
// with the thing's name on the end (see Web._share).
//
// iPhone only adds a Shortcut file Apple has signed, and only a Mac signs
// them: `shortcuts sign -m anyone -i in.shortcut -o Shelf.shortcut`. This
// builds the unsigned file that goes in.

const crypto = require('crypto');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A small XML plist writer: strings, numbers, booleans, arrays and dicts.
function plist(v, ind = '') {
  const i2 = ind + '\t';
  if (typeof v === 'string') return `${ind}<string>${esc(v)}</string>`;
  if (typeof v === 'boolean') return `${ind}<${v}/>`;
  if (typeof v === 'number') return Number.isInteger(v) ? `${ind}<integer>${v}</integer>` : `${ind}<real>${v}</real>`;
  if (Array.isArray(v)) return v.length ? `${ind}<array>\n${v.map((x) => plist(x, i2)).join('\n')}\n${ind}</array>` : `${ind}<array/>`;
  const keys = Object.keys(v);
  if (!keys.length) return `${ind}<dict/>`;
  return `${ind}<dict>\n${keys.map((k) => `${i2}<key>${esc(k)}</key>\n${plist(v[k], i2)}`).join('\n')}\n${ind}</dict>`;
}

const uuid = () => crypto.randomUUID().toUpperCase();
const OBJ = '￼';

function buildShortcut() {
  const textId = uuid();
  const group = uuid();
  const repeatItem = { Type: 'Variable', VariableName: 'Repeat Item' };
  const actions = [
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.gettext',
      WFWorkflowActionParameters: { UUID: textId, WFTextActionText: '' },
    },
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.repeat.each',
      WFWorkflowActionParameters: {
        GroupingIdentifier: group,
        WFControlFlowMode: 0,
        WFInput: { Value: { Type: 'ExtensionInput' }, WFSerializationType: 'WFTextTokenAttachment' },
      },
    },
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.downloadurl',
      WFWorkflowActionParameters: {
        UUID: uuid(),
        // The address from the Text action, then the shared thing's name.
        WFURL: {
          Value: {
            string: OBJ + OBJ,
            attachmentsByRange: {
              '{0, 1}': { Type: 'ActionOutput', OutputUUID: textId, OutputName: 'Text' },
              '{1, 1}': { ...repeatItem, Aggrandizements: [{ Type: 'WFPropertyVariableAggrandizement', PropertyName: 'Name' }] },
            },
          },
          WFSerializationType: 'WFTextTokenString',
        },
        WFHTTPMethod: 'POST',
        WFHTTPBodyType: 'File',
        WFRequestVariable: { Value: repeatItem, WFSerializationType: 'WFTextTokenAttachment' },
        ShowHeaders: false,
      },
    },
    {
      WFWorkflowActionIdentifier: 'is.workflow.actions.repeat.each',
      WFWorkflowActionParameters: { GroupingIdentifier: group, WFControlFlowMode: 2, UUID: uuid() },
    },
  ];
  const doc = {
    WFWorkflowClientVersion: '2607.0.2',
    WFWorkflowMinimumClientVersion: 900,
    WFWorkflowMinimumClientVersionString: '900',
    WFWorkflowIcon: { WFWorkflowIconStartColor: 463140863, WFWorkflowIconGlyphNumber: 59511 },
    WFWorkflowTypes: ['ActionExtension'],
    WFWorkflowHasShortcutInputVariables: true,
    WFWorkflowInputContentItemClasses: [
      'WFURLContentItem',
      'WFStringContentItem',
      'WFRichTextContentItem',
      'WFImageContentItem',
      'WFAVAssetContentItem',
      'WFPDFContentItem',
      'WFGenericFileContentItem',
      'WFSafariWebPageContentItem',
      'WFArticleContentItem',
    ],
    WFWorkflowOutputContentItemClasses: [],
    WFWorkflowImportQuestions: [
      {
        ActionIndex: 0,
        Category: 'Parameter',
        ParameterKey: 'WFTextActionText',
        Text: 'Paste your share address. Shelf copied it for you when you tapped Install. You can also copy it again in Shelf, Settings, Share Sheet.',
        DefaultValue: '',
      },
    ],
    WFWorkflowActions: actions,
  };
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n' + plist(doc) + '\n</plist>\n';
  return Buffer.from(xml, 'utf8');
}

// A file Apple signed starts with "AEA1" (an Apple Encrypted Archive).
function isSigned(buf) {
  return Buffer.isBuffer(buf) && buf.length > 64 && buf.subarray(0, 4).toString('latin1') === 'AEA1';
}

module.exports = { buildShortcut, isSigned };
