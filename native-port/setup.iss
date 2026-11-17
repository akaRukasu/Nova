[Setup]
AppId=NovaCord.Native.Test
AppName=Voxcord
AppVersion=0.7.0
DefaultDirName={localappdata}\Programs\Voxcord
DefaultGroupName=Voxcord
UsePreviousGroup=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\voxcord.exe
OutputBaseFilename=Voxcord-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#SourceDir}\voxcord.ico

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[InstallDelete]
Type: files; Name: "{app}\yapfast.exe"
Type: files; Name: "{app}\run-yapfast.cmd"
Type: files; Name: "{userprograms}\NovaCord Native\NovaCord Native.lnk"
Type: dirifempty; Name: "{userprograms}\NovaCord Native"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Voxcord"; Filename: "{app}\voxcord.exe"

[Run]
Filename: "{app}\voxcord.exe"; Description: "Lancer Voxcord"; Flags: nowait postinstall skipifsilent
