[Setup]
AppId=Nacre.Native
AppName=Nacre
AppVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\Nacre
DefaultGroupName=Nacre
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\nacre.exe
OutputDir=dist
OutputBaseFilename=Nacre-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "target\release\nacre.exe"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Nacre"; Filename: "{app}\nacre.exe"

[Run]
Filename: "{app}\nacre.exe"; Description: "Lancer Nacre"; Flags: nowait postinstall skipifsilent
