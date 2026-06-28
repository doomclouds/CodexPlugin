# Current PC Draw.io Libraries

## Evidence Source

- draw.io executable: `C:\Program Files\draw.io\draw.io.exe`
- installed file version: `29.7.8`
- packaged resources archive: `C:\Program Files\draw.io\resources\app.asar`
- inspection method used to build this reference:
  - `npx -y asar list "C:\Program Files\draw.io\resources\app.asar"`
  - filtered paths under:
    - `\drawio\src\main\webapp\stencils\`
    - `\drawio\src\main\webapp\templates\`
    - `\drawio\src\main\webapp\shapes\`

## Template Categories

Top-level template families present on this PC:

- `basic`
- `business`
- `charts`
- `cloud`
- `engineering`
- `flowcharts`
- `layout`
- `maps`
- `network`
- `other`
- `software`
- `tables`
- `uml`
- `venn`
- `wireframes`

## Stencil Library Families

Top-level stencil families present on this PC:

- `alibaba_cloud`
- `android`
- `arrows`
- `atlassian`
- `aws`
- `aws2`
- `aws3`
- `aws3d`
- `aws4`
- `azure`
- `basic`
- `bootstrap`
- `bpmn`
- `cabinets`
- `cisco`
- `cisco_safe`
- `cisco19`
- `citrix`
- `citrix2`
- `eip`
- `electrical`
- `floorplan`
- `flowchart`
- `fluid_power`
- `gcp`
- `gcp2`
- `gmdl`
- `ibm`
- `ibm_cloud`
- `ios7`
- `kubernetes`
- `kubernetes2`
- `lean_mapping`
- `mockup`
- `mscae`
- `networks`
- `networks2`
- `office`
- `openstack`
- `pid`
- `rack`
- `salesforce`
- `signs`
- `sitemap`
- `veeam`
- `vvd`
- `webicons`
- `weblogos`

## Named Shape Packs

Top-level shape packs present on this PC:

- `bpmn`
- `emoji`
- `er`
- `ios7`
- `mockup`
- `mxAndroid`
- `mxArchiMate`
- `mxArchiMate3`
- `mxArrows`
- `mxAtlassian`
- `mxAWS3D`
- `mxAWS4`
- `mxBasic`
- `mxBootstrap`
- `mxC4`
- `mxCabinets`
- `mxCisco19`
- `mxCiscoSafe`
- `mxDFD`
- `mxEip`
- `mxElectrical`
- `mxFloorplan`
- `mxFlowchart`
- `mxGCP2`
- `mxGmdl`
- `mxIBM`
- `mxInfographic`
- `mxKubernetes`
- `mxLeanMap`
- `mxNetworks`
- `mxNetworks2`
- `mxSAP`
- `mxSysML`
- `mxUML25`
- `pid2`
- `rack`

## Practical Mapping

Use these families first when choosing a visual language:

- Admin/dashboard UI: `bootstrap`, `mockup`, `layout`, `wireframes`
- Generic process: `flowchart`, `basic`, `bpmn`
- UML/software: `uml`, `software`, `mxUML25`, `mxC4`
- Cloud architecture: `aws4`, `azure`, `gcp`, `kubernetes`, `office`
- Enterprise/network/rack: `cisco`, `cisco19`, `cisco_safe`, `rack`, `networks`, `veeam`
- Specialized technical drawing: `electrical`, `pid`, `floorplan`, `engineering`

## Refresh Command

Use this skill's helper script to rebuild the inventory:

```powershell
powershell -ExecutionPolicy Bypass -File <drawio-template-shapes>\scripts\list-drawio-libraries.ps1
```

The script summarizes the current template categories, stencil families, and shape packs from the installed draw.io archive.
