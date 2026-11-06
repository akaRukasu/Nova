[Setup]
AppId=NovaCord.Native.Test
AppName=NovaCord Native
AppVersion=0.1.0
DefaultDirName={localappdata}\Programs\NovaCord Native
DefaultGroupName=NovaCord Native
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\yapfast.exe
OutputBaseFilename=NovaCord-Native-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\NovaCord Native"; Filename: "{app}\yapfast.exe"

[Run]
Filename: "{app}\yapfast.exe"; Description: "Lancer NovaCord Native"; Flags: nowait postinstall skipifsilent
