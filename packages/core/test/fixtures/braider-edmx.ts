/** Data Braider route $metadata fixtures: level 1 (read/write) and level 2 (+config API). */

const HEADER = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="Microsoft.NAV" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="read">
        <Key><PropertyRef Name="code" /></Key>
        <Property Name="code" Type="Edm.String" Nullable="false" MaxLength="20" />
        <Property Name="description" Type="Edm.String" />
        <Property Name="jsonResult" Type="Edm.String" />
        <Property Name="filterJson" Type="Edm.String" />
        <Property Name="pageStart" Type="Edm.Int32" />
        <Property Name="pageSize" Type="Edm.Int32" />
      </EntityType>
      <EntityType Name="write">
        <Key><PropertyRef Name="code" /></Key>
        <Property Name="code" Type="Edm.String" Nullable="false" MaxLength="20" />
        <Property Name="jsonInput" Type="Edm.String" />
        <Property Name="jsonResult" Type="Edm.String" />
      </EntityType>`;

const CONFIG_TYPES = `
      <EntityType Name="endpointConfig">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="code" Type="Edm.String" MaxLength="20" />
      </EntityType>
      <EntityType Name="endpointLine">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="lineNo" Type="Edm.Int32" />
      </EntityType>
      <EntityType Name="endpointField">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
        <Property Name="fieldNo" Type="Edm.Int32" />
      </EntityType>
      <EntityType Name="endpointRelation">
        <Key><PropertyRef Name="id" /></Key>
        <Property Name="id" Type="Edm.Guid" Nullable="false" />
      </EntityType>
      <EntityType Name="endpointSchema">
        <Key><PropertyRef Name="code" /></Key>
        <Property Name="code" Type="Edm.String" MaxLength="20" />
        <Property Name="readSchemaJson" Type="Edm.String" />
        <Property Name="writeSchemaJson" Type="Edm.String" />
      </EntityType>
      <EntityType Name="availableTable">
        <Key><PropertyRef Name="tableNo" /></Key>
        <Property Name="tableNo" Type="Edm.Int32" Nullable="false" />
        <Property Name="name" Type="Edm.String" />
      </EntityType>
      <EntityType Name="availableField">
        <Key><PropertyRef Name="tableNo" /><PropertyRef Name="fieldNo" /></Key>
        <Property Name="tableNo" Type="Edm.Int32" Nullable="false" />
        <Property Name="fieldNo" Type="Edm.Int32" Nullable="false" />
        <Property Name="name" Type="Edm.String" />
      </EntityType>`;

export const BRAIDER_EDMX_LEVEL1 = `${HEADER}
      <EntityContainer Name="NAV">
        <EntitySet Name="read" EntityType="Microsoft.NAV.read" />
        <EntitySet Name="write" EntityType="Microsoft.NAV.write" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

export const BRAIDER_EDMX_LEVEL2 = `${HEADER}${CONFIG_TYPES}
      <EntityContainer Name="NAV">
        <EntitySet Name="read" EntityType="Microsoft.NAV.read" />
        <EntitySet Name="write" EntityType="Microsoft.NAV.write" />
        <EntitySet Name="endpointConfigs" EntityType="Microsoft.NAV.endpointConfig" />
        <EntitySet Name="endpointLines" EntityType="Microsoft.NAV.endpointLine" />
        <EntitySet Name="endpointFields" EntityType="Microsoft.NAV.endpointField" />
        <EntitySet Name="endpointRelations" EntityType="Microsoft.NAV.endpointRelation" />
        <EntitySet Name="endpointSchemas" EntityType="Microsoft.NAV.endpointSchema" />
        <EntitySet Name="availableTables" EntityType="Microsoft.NAV.availableTable" />
        <EntitySet Name="availableFields" EntityType="Microsoft.NAV.availableField" />
      </EntityContainer>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
