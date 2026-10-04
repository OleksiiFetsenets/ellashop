; Packages the Windows application, shortcuts, and uninstall entries.
; build.ps1 prepares the files and the release workflow invokes this installer.
; Compile with ISCC.exe /DAppVersion=1.2.3 windows\ellashop.iss.
#ifndef AppVersion
  #error AppVersion must be passed with /DAppVersion=<VERSION>
#endif

[Setup]
AppId={{A3448D16-8309-4A71-9283-998254D2D90D}
AppName=Ellashop
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Ellashop
DefaultGroupName=Ellashop
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=Ellashop-Setup-{#AppVersion}
SetupIconFile=ellashop.ico
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\windows\ellashop.ico

[Files]
Source: "..\build\Ellashop\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{userprograms}\Ellashop"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\desktop.py"""; WorkingDir: "{app}"; IconFilename: "{app}\windows\ellashop.ico"
Name: "{userdesktop}\Ellashop"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\desktop.py"""; WorkingDir: "{app}"; IconFilename: "{app}\windows\ellashop.ico"

[Run]
Filename: "{app}\windows\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; StatusMsg: "Installing Microsoft Edge WebView2 Runtime..."; Flags: waituntilterminated; Check: not WebView2Installed
Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\app\desktop.py"""; WorkingDir: "{app}"; Description: "Launch Ellashop"; Flags: postinstall nowait skipifsilent

[Code]
function WebView2Installed: Boolean;
var
  Version: String;
begin
  Result :=
    (RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F1C5DDFE-5C31-4A4A-BF19-DBE7A5A8A6A5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0')) or
    (RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F1C5DDFE-5C31-4A4A-BF19-DBE7A5A8A6A5}', 'pv', Version) and (Version <> '') and (Version <> '0.0.0.0'));
end;
