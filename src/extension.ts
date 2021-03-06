'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/lib/main';
import { Highlighter, Highlight } from './highlighter';
import CredentialManager, { TwitchCredentials } from './credentialManager';
import {
  TwitchHighlighterDataProvider,
  HighlighterNode
} from './twitchhighlighterTreeView';

const highlightDecorationType = vscode.window.createTextEditorDecorationType({
  backgroundColor: 'green',
  border: '2px solid white'
});
const twitchhighlighterStatusBarIcon: string = '$(plug)'; // The octicon to use for the status bar icon (https://octicons.github.com/)
let highlighters: Array<Highlighter> = new Array<Highlighter>();
let client: LanguageClient;
let twitchhighlighterTreeView: TwitchHighlighterDataProvider;
let twitchhighlighterStatusBar: vscode.StatusBarItem;
let isConnected: boolean = false;

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  let serverModule = context.asAbsolutePath(path.join('out', 'server.js'));
  let debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
  let serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: debugOptions
    }
  };
  let clientOptions: LanguageClientOptions = {
    // Register the server for everything
    documentSelector: ['*'],
    synchronize: {
      // Synchronize the setting section to the server
      configurationSection: 'twitchhighlighter'
    }
  };

  client = new LanguageClient(
    'twitchChatLanguageServer',
    serverOptions,
    clientOptions
  );

  client.onReady().then(() => {
    client.onNotification('error', (params: any) => {
      console.debug('Error handling in extension from client has been reached');
      vscode.window.showErrorMessage(params.message);
    });
    client.onNotification('exited', () => {
      vscode.window.showInformationMessage(
        'Twitch Highlighter: Chat Listener Stopped'
      );
      setConnectionStatus(false);
    });

    client.onNotification('highlight', (params: any) => {
      console.debug(params);
      if (!params.line) {
        vscode.window.showWarningMessage(
          'A line number was not provided to unhighlight'
        );
        return;
      }
      executeHighlight(params.line, params.twitchUser);
    });

    client.onNotification('unhighlight', (params: any) => {
      console.debug(params);
      if (!params.line) {
        vscode.window.showWarningMessage(
          'A line number was not provided to unhighlight'
        );
        return;
      }
      let currentDocumentFilename: string;
      if (!params.fileName) {
        // We need to assume it's for the currently opened file
        let editor = vscode.window.activeTextEditor;
        if (!editor) {
          vscode.window.showWarningMessage(
            'A file was not found to perform the unhighlight'
          );
          return;
        }
        currentDocumentFilename = editor.document.fileName;
      } else {
        const existingHighlighter = highlighters.find(highlighter => {
          return highlighter.editor.document.fileName.includes(params.fileName);
        });
        if (!existingHighlighter) {
          vscode.window.showWarningMessage(
            'A file was not found to perform the unhighlight'
          );
          return;
        }
        currentDocumentFilename = existingHighlighter.editor.document.fileName;
      }
      const lineNumberInt = parseInt(params.line);
      removeHighlight(lineNumberInt, currentDocumentFilename);
    });
  });

  const runningClient = client.start();
  context.subscriptions.push(runningClient);

  twitchhighlighterTreeView = new TwitchHighlighterDataProvider(() => {
    return highlighters;
  }, vscode.workspace.rootPath);
  vscode.window.registerTreeDataProvider(
    'twitchHighlighterTreeView',
    twitchhighlighterTreeView
  );

  const gotoHighlightCommand = vscode.commands.registerCommand(
    'twitchhighlighter.gotoHighlight',
    (lineNumber: number, fileName: string) => {
      vscode.workspace.findFiles(fileName).then(results => {
        vscode.workspace.openTextDocument(results[0]).then(document => {
          vscode.window.showTextDocument(document).then(editor => {
            lineNumber = lineNumber < 3 ? 2 : lineNumber;
            editor.revealRange(document.lineAt(lineNumber - 2).range);
          });
        });
      });
    }
  );
  context.subscriptions.push(gotoHighlightCommand);

  const removeHighlightCommand = vscode.commands.registerCommand(
    'twitchhighlighter.removeHighlight',
    (highlighterNode: HighlighterNode) => {
      const highlightsToRemove = Array<{
        lineNumber: number;
        fileName: string;
      }>();
      highlighterNode.highlights.map(highlight =>
        highlightsToRemove.push({
          lineNumber: highlight.lineNumber,
          fileName: `${vscode.workspace.rootPath}\\${highlighterNode.fileName}`
        })
      );
      highlightsToRemove.forEach(v =>
        removeHighlight(v.lineNumber, v.fileName, true)
      );
      twitchhighlighterTreeView.refresh();
    }
  );
  context.subscriptions.push(removeHighlightCommand);

  // #region command registrations
  registerCommand(context, 'twitchhighlighter.refreshTreeView', () =>
    twitchhighlighterTreeView.refresh()
  );
  registerCommand(
    context,
    'twitchhighlighter.setTwitchClientId',
    setTwitchClientIdHandler
  );
  registerCommand(
    context,
    'twitchhighlighter.removeTwitchClientId',
    removeTwitchClientIdHandler
  );
  registerCommand(
    context,
    'twitchhighlighter.setTwitchPassword',
    setTwitchPasswordHandler
  );
  registerCommand(
    context,
    'twitchhighlighter.removeTwitchPassword',
    removeTwitchPasswordHandler
  );
  registerCommand(context, 'twitchhighlighter.startChat', startChatHandler);
  registerCommand(context, 'twitchhighlighter.stopChat', stopChatHandler);
  registerCommand(context, 'twitchhighlighter.toggleChat', toggleChatHandler);
  registerCommand(context, 'twitchhighlighter.highlight', highlightHandler);
  registerCommand(
    context,
    'twitchhighlighter.unhighlightSpecific',
    unhighlightSpecificHandler
  );
  registerCommand(
    context,
    'twitchhighlighter.unhighlightAll',
    unhighlightAllHandler
  );
  // #endregion command registrations

  // #region command handlers
  function setTwitchClientIdHandler() {
    vscode.window
      .showInputBox({
        prompt:
          'Enter Twitch Client Id. Register your app here: https://glass.twitch.tv/console/apps/create',
        password: true
      })
      .then(setTwitchClientIdWithCredentialManager);
  }

  function setTwitchClientIdWithCredentialManager(value: string | undefined) {
    if (value !== undefined) {
      CredentialManager.setClientId(value)
        .then(() => {
          vscode.window.showInformationMessage(
            `Twitch Client Id saved in your keychain`
          );
        })
        .catch(reason => {
          vscode.window.showInformationMessage(
            `Failed to set Twitch Chat Client Id`
          );
          console.error(
            'An error occured while saving your password to the keychain'
          );
          console.error(reason);
        });
    }
  }

  function removeTwitchClientIdHandler() {
    CredentialManager.deleteTwitchClientId()
      .then((value: boolean) => {
        vscode.window.showInformationMessage(
          `Twitch Chat Client Id removed from your keychain`
        );
      })
      .catch(reason => {
        vscode.window.showInformationMessage(
          `Failed to remove the Twitch Chat Client Id`
        );
        console.error(
          'An error occured while removing your Client Id from the keychain'
        );
        console.error(reason);
      });
  }

  function setTwitchPasswordHandler() {
    vscode.window
      .showInputBox({
        prompt:
          'Enter Twitch token. Generate a token here: http://www.twitchapps.com/tmi',
        password: true
      })
      .then(setPasswordWithCredentialManager);
  }

  function setPasswordWithCredentialManager(value: string | undefined) {
    if (value !== undefined) {
      CredentialManager.setPassword(value)
        .then(() => {
          vscode.window.showInformationMessage(
            `Twitch Chat password saved in your keychain`
          );
        })
        .catch(reason => {
          vscode.window.showInformationMessage(
            `Failed to set Twitch Chat password`
          );
          console.error(
            'An error occured while saving your password to the keychain'
          );
          console.error(reason);
        });
    }
  }

  function removeTwitchPasswordHandler() {
    CredentialManager.deletePassword()
      .then((value: boolean) => {
        vscode.window.showInformationMessage(
          `Twitch Chat password removed from your keychain`
        );
      })
      .catch(reason => {
        vscode.window.showInformationMessage(
          `Failed to remove the Twitch Chat password`
        );
        console.error(
          'An error occured while removing your password from the keychain'
        );
        console.error(reason);
      });
  }

  function highlightHandler() {
    vscode.window
      .showInputBox({ prompt: 'Enter a line number' })
      .then(executeHighlight);
  }

  function unhighlightAllHandler() {
    vscode.window.visibleTextEditors.forEach(visibleEditor => {
      visibleEditor.setDecorations(highlightDecorationType, []);
    });
    highlighters = new Array<Highlighter>();
    twitchhighlighterTreeView.refresh();
  }

  function unhighlightSpecificHandler() {
    if (highlighters.length === 0) {
      vscode.window.showInformationMessage(
        'There are no highlights to unhighlight'
      );
    }
    let pickerOptions: Array<string> = new Array<string>();
    highlighters.forEach(highlighter => {
      pickerOptions = [...pickerOptions, ...highlighter.getPickerDetails()];
    });

    vscode.window.showQuickPick(pickerOptions).then(pickedOption => {
      if (!pickedOption) {
        vscode.window.showErrorMessage('A valid highlight was not selected.');
        return;
      }
      const [pickedFile, lineNumber] = pickedOption.split(', ');
      const lineNumberInt = parseInt(lineNumber);
      removeHighlight(lineNumberInt, pickedFile);
    });
  }

  function startChatHandler() {
    setConnectionStatus(false, true);
    console.debug('Retrieving twitch credentials');
    CredentialManager.getTwitchCredentials()
      .then((creds: TwitchCredentials | null) => {
        if (creds === null) {
          vscode.window.showInformationMessage(
            'Missing Twitch credentials. Cannot start Chat client'
          );
          return;
        }

        vscode.window.showInformationMessage(
          'Twitch Highlighter: Starting Chat Listener...'
        );

        // TODO: get channels and username from extension specific settings
        const chatParams = {
          channels: ['clarkio'],
          clientId: creds.clientId,
          username: 'clarkio',
          password: creds.password
        };
        client.sendRequest('startchat', chatParams).then(
          result => {
            console.debug('We have begun connection with the Language Server');
            vscode.window.showInformationMessage(
              'Twitch Highlighter: Chat Listener Connected.'
            );
            setConnectionStatus(true);
          },
          () => {
            vscode.window.showErrorMessage('Unable to connect to Twitch Chat');
          }
        );
      })
      .catch(reason => {
        vscode.window.showErrorMessage('Could not start the chat client');
        console.error(
          'An error occured while gathering the Twitch credentials'
        );
        console.error(reason);
      });
  }

  function stopChatHandler() {
    vscode.window.showInformationMessage(
      'Twitch Highlighter: Stopping Chat Listener...'
    );
    client.sendRequest('stopchat').then(
      result => {
        if (!result) {
          vscode.window.showErrorMessage(
            'Twitch Highlighter: Unable to stop listening to chat'
          );
          return;
        }
        setConnectionStatus(false);
        vscode.window.showInformationMessage(
          'Twitch Highlighter: Stopped Listening to Chat'
        );
      },
      error => {
        vscode.window.showErrorMessage(
          'Twitch Highlighter: Unable to stop listening to chat'
        );
      }
    );
  }

  function toggleChatHandler() {
    if (!isConnected) {
      startChatHandler();
    } else {
      stopChatHandler();
    }
  }
  // #endregion command handlers

  function setConnectionStatus(
    connectionStatus: boolean,
    isConnecting?: boolean
  ) {
    isConnected = connectionStatus;
    if (connectionStatus) {
      twitchhighlighterStatusBar.text = `${twitchhighlighterStatusBarIcon} Connected`;
    } else {
      if (isConnecting) {
        twitchhighlighterStatusBar.text = `${twitchhighlighterStatusBarIcon} Connecting...`;
      } else {
        twitchhighlighterStatusBar.text = `${twitchhighlighterStatusBarIcon} Disconnected`;
      }
    }
  }

  function executeHighlight(
    lineNumber: string | undefined,
    twitchUser: string = 'self'
  ) {
    if (!lineNumber || isNaN(+lineNumber)) {
      return;
    }
    const lineNumberInt: number = parseInt(lineNumber);

    let editor = vscode.window.activeTextEditor;
    if (editor) {
      let doc = editor.document;
      let existingHighlighter = highlighters.find(highlighter => {
        return highlighter.editor.document.fileName === doc.fileName;
      });
      let range = getHighlightRange(lineNumber, doc);
      let decoration = {
        range,
        hoverMessage: `From @${twitchUser === 'self' ? 'You' : twitchUser}`
      };
      addHighlight(
        existingHighlighter,
        decoration,
        editor,
        lineNumberInt,
        twitchUser
      );
    }
  }

  // Listen for active text editor or document so we don't lose any existing highlights
  let activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    triggerUpdateDecorations();
  }

  vscode.window.onDidChangeActiveTextEditor(
    editor => {
      activeEditor = editor;
      if (editor) {
        triggerUpdateDecorations();
      }
    },
    null,
    context.subscriptions
  );

  vscode.workspace.onDidChangeTextDocument(
    event => {
      if (activeEditor && event.document === activeEditor.document) {
        triggerUpdateDecorations();
      }
    },
    null,
    context.subscriptions
  );

  // Creates the status bar toggle button
  twitchhighlighterStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right
  );
  twitchhighlighterStatusBar.command = 'twitchhighlighter.toggleChat';
  twitchhighlighterStatusBar.tooltip = `Twitch Highlighter Extension`;
  context.subscriptions.push(twitchhighlighterStatusBar);

  setConnectionStatus(false);
  twitchhighlighterStatusBar.show();

  function triggerUpdateDecorations() {
    if (!activeEditor) {
      return;
    }
    let existingHighlight = highlighters.find(highlight => {
      return (
        highlight.editor.document.fileName === activeEditor!.document.fileName
      );
    });
    if (existingHighlight) {
      activeEditor.setDecorations(
        highlightDecorationType,
        existingHighlight.getAllDecorations()
      );
    }
  }

  function addHighlight(
    existingHighlighter: Highlighter | undefined,
    decoration: { range: vscode.Range; hoverMessage: string },
    editor: vscode.TextEditor,
    lineNumber: number,
    twitchUser: string
  ) {
    if (existingHighlighter) {
      // We have a new decoration for a highlight with decorations already in a file
      // Add the decoration (a.k.a. style range) to the existing highlight's decoration array
      // Reapply decoration type for updated decorations array in this highlight
      existingHighlighter.addHighlight(
        new Highlight(decoration, lineNumber, twitchUser)
      );
    } else {
      const highlighter = new Highlighter(editor, [
        new Highlight(decoration, lineNumber, twitchUser)
      ]);
      highlighters.push(highlighter);
    }
    triggerUpdateDecorations();
    twitchhighlighterTreeView.refresh();
  }

  function removeHighlight(
    lineNumber: number,
    fileName: string,
    deferRefresh?: boolean
  ) {
    const existingHighlight = findHighlighter(fileName);
    if (!existingHighlight) {
      console.warn(
        `Highlight not found so can't unhighlight the line from file`
      );
      return;
    }

    existingHighlight.removeDecoration(lineNumber);
    triggerUpdateDecorations();
    if (!deferRefresh) {
      twitchhighlighterTreeView.refresh();
    }
  }
}

function findHighlighter(fileName: string): Highlighter | undefined {
  return highlighters.find(highlighter => {
    return highlighter.editor.document.fileName === fileName;
  });
}

function getHighlightRange(lineNumber: string, doc: vscode.TextDocument) {
  // prefix string with plus (+) to make string a number
  // well at least that's what codephobia says :P
  const zeroIndexedLineNumber = +lineNumber - 1;
  // note: doc.lineAt is zero based index so remember to always do -1 from input
  let textLine = doc.lineAt(zeroIndexedLineNumber);
  let textLineLength = textLine.text.length;
  let range = new vscode.Range(
    new vscode.Position(zeroIndexedLineNumber, 0),
    new vscode.Position(zeroIndexedLineNumber, textLineLength)
  );
  return range;
}

export function deactivate(): Thenable<void> {
  if (!client) {
    return Promise.resolve();
  }
  return client.stop();
}

function registerCommand(
  context: vscode.ExtensionContext,
  name: string,
  handler: () => void
) {
  let disposable = vscode.commands.registerCommand(name, handler);
  context.subscriptions.push(disposable);
}
