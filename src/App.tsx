import { TitleBar, WindowFrame } from "./chrome/TitleBar";
import { Viewport } from "./viewer/Viewport";
import { UpdateHost } from "./updater/UpdateDialog";
import { DialogHost } from "./prefs/DialogHost";
import { InspectorHost } from "./inspector/Inspector";

export default function App() {
  return (
    <WindowFrame>
      <TitleBar title="Gera View Image" />
      <div className="app-body">
        <Viewport />
      </div>
      <UpdateHost />
      <DialogHost />
      <InspectorHost />
    </WindowFrame>
  );
}
